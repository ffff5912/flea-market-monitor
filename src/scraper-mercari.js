// scraper-mercari.js（カテゴリ抽出改良版 - 全文）
const puppeteer = require('puppeteer');
const { Client } = require('pg');

// 汎用的なカテゴリ抽出関数（改良版）
function extractCategory(title) {
  // 1. ノイズ除去
  let cleaned = title
    // 装飾記号を削除
    .replace(/【[^】]*】/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/「[^」]*」/g, '')
    
    // 状態系キーワードを削除
    .replace(/新品未使用|新品|未使用|中古|美品|未開封/g, '')
    .replace(/送料込み?|送料無料/g, '')
    
    // 数量・セット表記を削除
    .replace(/\d+\s*(個|枚|本|セット|点|冊)/g, '')
    .replace(/\d+セット/g, '')
    
    // 限定版などの付加情報を削除
    .replace(/限定版|通常版|初回版|特典付き?/g, '')
    
    // 連続スペースを整理
    .replace(/\s+/g, ' ')
    .trim();
  
  // 2. 抽出戦略
  
  // 戦略A: スペース区切りで最初の2-3単語（日本語タイトル向け）
  const words = cleaned.split(/\s+/);
  if (words.length >= 2) {
    // 最初の2-3単語を結合
    const candidate = words.slice(0, Math.min(3, words.length)).join(' ');
    if (candidate.length >= 5 && candidate.length <= 30) {
      return candidate;
    }
  }
  
  // 戦略B: 最初の15-20文字（長いタイトル向け）
  if (cleaned.length > 20) {
    return cleaned.substring(0, 20).trim();
  }
  
  // 戦略C: そのまま返す
  return cleaned.substring(0, 30).trim();
}

// DBから売れ筋キーワードを分析
async function analyzeKeywordsFromDB() {
  if (!process.env.DATABASE_URL) {
    console.log('[DB分析] DATABASE_URL未設定 - スキップ');
    return null;
  }

  console.log('[DB分析] 売れ筋キーワードを分析中...');
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  await client.connect();
  
  // SOLD商品から頻出ワードを抽出
  const result = await client.query(`
    SELECT 
      keyword,
      COUNT(*) as sold_count,
      AVG(price) as avg_price,
      MAX(created_at) as last_scraped
    FROM products
    WHERE 
      source = 'mercari' 
      AND status = 'SOLD'
      AND created_at > NOW() - INTERVAL '7 days'
    GROUP BY keyword
    HAVING COUNT(*) > 10
    ORDER BY sold_count DESC
    LIMIT 10
  `);
  
  await client.end();
  
  if (result.rows.length > 0) {
    const keywords = result.rows.map(r => r.keyword);
    console.log(`[DB分析] ${keywords.length}件のキーワード抽出:`);
    result.rows.forEach(r => {
      console.log(`  - ${r.keyword}: ${r.sold_count}件売れ (平均¥${Math.round(r.avg_price)})`);
    });
    return keywords;
  }
  
  return null;
}

// キーワード取得（優先順位: 環境変数 > DB分析 > デフォルト）
async function getKeywords() {
  if (process.env.KEYWORDS) {
    const keywords = process.env.KEYWORDS.split(',').map(k => k.trim());
    console.log(`[キーワード] 環境変数から取得: ${keywords.join(', ')}`);
    return keywords;
  }
  
  if (process.env.AUTO_KEYWORD === 'true') {
    try {
      const analyzed = await analyzeKeywordsFromDB();
      if (analyzed && analyzed.length > 0) {
        console.log(`[キーワード] DB分析から取得: ${analyzed.join(', ')}`);
        return analyzed;
      }
    } catch (e) {
      console.error('[DB分析] エラー:', e.message);
    }
  }
  
  const defaultKeywords = ['ゲーム'];
  console.log(`[キーワード] デフォルト使用: ${defaultKeywords.join(', ')}`);
  return defaultKeywords;
}

async function scrapeMercari(keyword, status = 'on_sale') {
  console.log(`[メルカリ] ${keyword} (${status}) をスクレイピング中...`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  );

  // 新しい順にソート
  const statusParam = status === 'sold' ? '&status=sold' : '';
  const url = `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}&sort=created_time&order=desc${statusParam}`;
  
  await page.goto(url, { 
    waitUntil: 'networkidle2', 
    timeout: 30000 
  });

  await autoScroll(page, 20);

  const products = await page.evaluate(() => {
    const items = [];
    const links = document.querySelectorAll('a[href^="/item/m"]');
    const seen = new Set();

    links.forEach((link) => {
      const href = link.getAttribute('href');
      const productId = href.split('/').pop();
      
      if (seen.has(productId)) return;
      seen.add(productId);
      
      try {
        const titleEl = link.querySelector('[data-testid="thumbnail-item-name"]');
        let title = titleEl?.textContent?.trim();
        
        if (!title) {
          const ariaLabel = link.getAttribute('aria-label');
          if (ariaLabel) {
            title = ariaLabel.replace(/の画像.*/, '').trim();
          }
        }
        
        if (!title) {
          const img = link.querySelector('img');
          title = img?.getAttribute('alt')?.replace(/のサムネイル$/, '');
        }
        
        const priceEl = link.querySelector('.number__6b270ca7');
        const price = priceEl ? parseInt(priceEl.textContent.replace(/[^0-9]/g, '')) : 0;
        
        if (productId && title && price > 0) {
          items.push({
            productId,
            title: title.trim(),
            price,
            url: 'https://jp.mercari.com' + href,
            status: '販売中'
          });
        }
      } catch (e) {
        console.error('Parse error:', e.message);
      }
    });

    return items;
  });

  await browser.close();

  products.forEach(p => p.status = status === 'sold' ? 'SOLD' : '販売中');

  console.log(`[メルカリ] ${products.length}件取得`);
  
  // 商品IDとカテゴリも表示
  products.slice(0, 5).forEach(p => {
    const category = extractCategory(p.title);
    console.log(`  - [${p.productId}] ${p.title.substring(0, 40)}... → [${category}] ¥${p.price.toLocaleString()} [${p.status}]`);
  });

  return products;
}

async function autoScroll(page, maxScrolls = 20) {
  await page.evaluate(async (maxScrolls) => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      let scrolls = 0;
      
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        scrolls++;

        if (totalHeight >= scrollHeight || scrolls >= maxScrolls) {
          clearInterval(timer);
          resolve();
        }
      }, 500);
    });
  }, maxScrolls);
  
  await new Promise(resolve => setTimeout(resolve, 2000));
}

async function saveToDatabase(items, keyword) {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] DATABASE_URL未設定 - スキップ');
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  await client.connect();
  
  let savedCount = 0;
  for (const item of items) {
    const category = extractCategory(item.title);
    
    await client.query(`
      INSERT INTO products (
        product_id, title, price, url, source, keyword, category, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (product_id, source) 
      DO UPDATE SET 
        price = EXCLUDED.price,
        status = EXCLUDED.status,
        category = EXCLUDED.category,
        sold_at = CASE 
          WHEN products.status != 'SOLD' AND EXCLUDED.status = 'SOLD' 
          THEN CURRENT_TIMESTAMP 
          ELSE products.sold_at 
        END,
        updated_at = CURRENT_TIMESTAMP
    `, [
      item.productId,
      item.title,
      item.price,
      item.url,
      'mercari',
      keyword,
      category,
      item.status,
      new Date()
    ]);
    savedCount++;
  }
  
  await client.end();
  console.log(`[DB] ${savedCount}件保存完了`);
}

// メイン実行
(async () => {
  const KEYWORDS = await getKeywords();
  
  for (const keyword of KEYWORDS) {
    const onSaleItems = await scrapeMercari(keyword, 'on_sale');
    await saveToDatabase(onSaleItems, keyword);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const soldItems = await scrapeMercari(keyword, 'sold');
    await saveToDatabase(soldItems, keyword);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  console.log('\n✅ 完了!');
  process.exit(0);
})();
