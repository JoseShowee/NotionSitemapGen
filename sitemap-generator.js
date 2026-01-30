require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Configuration
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID;
const SITEMAP_PAGE_ID = process.env.NOTION_SITEMAP_PAGE_ID;
const MAX_DEPTH = 4; // Prevent infinite recursion

/**
 * Fetch page details including title and child pages
 */
async function getPageDetails(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const title = extractTitle(page);

    return {
      id: pageId,
      title: title,
      url: `https://www.notion.so/${pageId.replace(/-/g, '')}`,
      type: page.object,
      lastEdited: page.last_edited_time
    };
  } catch (error) {
    console.error(`Error fetching page ${pageId}:`, error.message);
    return null;
  }
}

/**
 * Extract title from page object
 */
function extractTitle(page) {
  if (page.properties.title?.title?.[0]?.plain_text) {
    return page.properties.title.title[0].plain_text;
  }
  if (page.properties.Name?.title?.[0]?.plain_text) {
    return page.properties.Name.title[0].plain_text;
  }
  // Check all properties for a title type
  for (const [key, value] of Object.entries(page.properties)) {
    if (value.type === 'title' && value.title?.[0]?.plain_text) {
      return value.title[0].plain_text;
    }
  }
  return 'Untitled';
}

/**
 * Get all child blocks/pages of a page
 */
async function getChildPages(pageId) {
  const children = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    try {
      const response = await notion.blocks.children.list({
        block_id: pageId,
        start_cursor: startCursor,
        page_size: 100
      });

      for (const block of response.results) {
        if (block.type === 'child_page') {
          children.push({
            id: block.id,
            title: block.child_page.title,
            type: 'page'
          });
        }
        if (block.type === 'child_database') {
          children.push({
            id: block.id,
            title: block.child_database.title,
            type: 'database'
          });
        }
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor;
    } catch (error) {
      console.error(`Error fetching children of ${pageId}:`, error.message);
      break;
    }
  }

  return children;
}

/**
 * Recursively build sitemap tree
 */
async function buildSitemapTree(pageId, depth = 0, visited = new Set()) {
  if (depth > MAX_DEPTH || visited.has(pageId)) {
    return null;
  }

  visited.add(pageId);

  const pageDetails = await getPageDetails(pageId);
  if (!pageDetails) return null;

  const childItems = await getChildPages(pageId);
  const children = [];

  for (const child of childItems) {
    // For child pages, recursively build tree
    if (child.type === 'page') {
      const childTree = await buildSitemapTree(child.id, depth + 1, visited);
      if (childTree) {
        children.push(childTree);
      }
    } else if (child.type === 'database') {
      // For databases, just add as a leaf node
      children.push({
        id: child.id,
        title: child.title || 'Untitled Database',
        url: `https://www.notion.so/${child.id.replace(/-/g, '')}`,
        type: 'database',
        children: [],
        depth: depth + 1
      });
    }
  }

  return {
    ...pageDetails,
    children,
    depth
  };
}

/**
 * Convert sitemap tree to Notion blocks
 */
function treeToNotionBlocks(tree, depth = 0) {
  const blocks = [];

  if (!tree) return blocks;

  const emoji = getEmojiForDepth(depth, tree.type);

  if (depth === 0) {
    // Root page - use heading
    blocks.push({
      object: 'block',
      type: 'heading_1',
      heading_1: {
        rich_text: [{
          type: 'text',
          text: { content: `${emoji} ${tree.title}` }
        }]
      }
    });
  } else {
    // Child pages - use bulleted list with link
    blocks.push({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [
          {
            type: 'text',
            text: { content: `${emoji} ` }
          },
          {
            type: 'text',
            text: {
              content: tree.title,
              link: { url: tree.url }
            },
            annotations: { bold: depth === 1 }
          },
          tree.type === 'database' ? {
            type: 'text',
            text: { content: ' [DB]' },
            annotations: { italic: true, color: 'gray' }
          } : null
        ].filter(Boolean)
      }
    });
  }

  // Add children recursively
  for (const child of tree.children) {
    blocks.push(...treeToNotionBlocks(child, depth + 1));
  }

  return blocks;
}

/**
 * Get emoji based on depth for visual hierarchy
 */
function getEmojiForDepth(depth, type) {
  if (type === 'database') return '🗃️';
  const emojis = ['🏢', '📁', '📄', '📎', '•'];
  return emojis[Math.min(depth, emojis.length - 1)];
}

/**
 * Update the sitemap page in Notion
 */
async function updateSitemapPage(blocks) {
  try {
    // First, clear existing content
    const existingBlocks = await notion.blocks.children.list({
      block_id: SITEMAP_PAGE_ID
    });

    // Delete existing blocks
    for (const block of existingBlocks.results) {
      try {
        await notion.blocks.delete({ block_id: block.id });
      } catch (err) {
        console.warn(`Could not delete block ${block.id}:`, err.message);
      }
    }

    // Add metadata header
    const metadataBlocks = [
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [{
            type: 'text',
            text: { content: `Auto-generated sitemap • Last updated: ${new Date().toLocaleString('es-ES')}` }
          }],
          icon: { emoji: '🗺️' },
          color: 'blue_background'
        }
      },
      {
        object: 'block',
        type: 'divider',
        divider: {}
      }
    ];

    // Add all blocks in batches of 100 (Notion API limit)
    const allBlocks = [...metadataBlocks, ...blocks];

    for (let i = 0; i < allBlocks.length; i += 100) {
      const batch = allBlocks.slice(i, i + 100);
      await notion.blocks.children.append({
        block_id: SITEMAP_PAGE_ID,
        children: batch
      });
    }

    console.log('✅ Sitemap updated successfully!');
  } catch (error) {
    console.error('Error updating sitemap page:', error.message);
    throw error;
  }
}

/**
 * Count total pages in tree
 */
function countPages(tree) {
  if (!tree) return 0;
  return 1 + tree.children.reduce((sum, child) => sum + countPages(child), 0);
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Starting sitemap generation...');
  console.log(`📍 Root page: ${ROOT_PAGE_ID}`);
  console.log(`📍 Sitemap page: ${SITEMAP_PAGE_ID}`);

  if (!ROOT_PAGE_ID || !SITEMAP_PAGE_ID || !process.env.NOTION_TOKEN) {
    console.error('❌ Missing required environment variables. Check your .env file.');
    process.exit(1);
  }

  const tree = await buildSitemapTree(ROOT_PAGE_ID);

  if (!tree) {
    console.error('❌ Failed to build sitemap tree');
    process.exit(1);
  }

  const pageCount = countPages(tree);
  console.log(`📊 Found ${pageCount} pages/databases`);

  const blocks = treeToNotionBlocks(tree);
  await updateSitemapPage(blocks);

  console.log('✨ Done!');
}

// Run the script
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
