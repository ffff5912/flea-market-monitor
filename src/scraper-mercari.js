// デバッグ版 scraper-mercari.js
const puppeteer = require('puppeteer');
const { Client } = require('pg');
const fs = require('fs');

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

  const statusParam = status === 'sold' ? '&status=sold' : '';
  const url = `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}${statusParam}`;
  
  console.log(`URL: ${url}`);
  
  await page.goto(url, { 
    waitUntil: 'networkidle2', 
    timeout: 30000 
  });

  // ★ デバッグ: HTMLを保存
  const html = await page.content();
  fs.writeFileSync(`debug-${status}.html`, html);
  console.log(`HTML saved to debug-${status}.html`);

  // ★ デバッグ: スクリーンショット
  await page.screenshot({ path: `debug-${status}.png`, fullPage: true });
  console.log(`Screenshot saved to debug-${status}.png`);

  // ★ デバッグ: 何が見えているか確認
  const debugInfo = await page.evaluate(() => {
    return {
      title: document.title,
      bodyText: document.body.innerText.substring(0, 500),
      itemCells: document.querySelectorAll('[data-testid="item-cell"]').length,
      allDataTestIds: Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => el.getAttribute('data-testid'))
        .slice(0, 20)
    };
  });
  
  console.log('デバッグ情報:', JSON.stringify(debugInfo, null, 2));

  // 実際のスクレイピング
  const products = await page.evaluate(() => {
    const items = [];
    
    // 複数のセレクタを試す
    const selectors = [
      '[data-testid="item-cell"]',
      '.item-box',
      'mer-item-thumbnail',
      '[class*="Item"]'
    ];
    
    let elements = null;
    let usedSelector = '';
    
    for (const selector of selectors) {
      elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        usedSelector = selector;
        break;
      }
    }
    
    console.log(`Using selector: ${usedSelector}, found: ${elements?.length || 0}`);
    
    if (!elements || elements.length === 0) {
      return { items: [], selector: 'none', error: 'No elements found' };
    }

    elements.forEach((el, idx) => {
      if (idx >= 30) return;
      
      try {
        // タイトル取得（複数パターン）
        const titleSelectors = [
          '[data-testid="thumbnail-item-name"]',
          '.item-name',
          'mer-item-name'
        ];
        
        let title = null;
        for (const sel of titleSelectors) {
          const titleEl = el.querySelector(sel);
          if (titleEl) {
            title = titleEl.textContent?.trim();
            break;
          }
        }
        
        // 価格取得（複数パターン）
        const priceSelectors = [
          '.merPrice .number__6b270ca7',
          '[class*="price"]',
          'mer-price'
        ];
        
        let priceText = null;
        for (const sel of priceSelectors) {
          const priceEl = el.querySelector(sel);
          if (priceEl) {
            priceText = priceEl.textContent;
            break;
          }
        }
        
        const price = parseInt(priceText?.replace(/[^0-9]/g, '') || '0');
        
        // URL取得
        const linkEl = el.querySelector('a[href*="/item/"]');
        const href = linkEl?.getAttribute('href');
        const productId = href?.split('/').pop();
        
        if (title && price && productId) {
          items.push({
            productId,
            title,
            price,
            url: 'https://jp.mercari.com' + href
          });
        }
      } catch (e) {
        console.error('Parse error:', e.message);
      }
    });

    return { items, selector: usedSelector, count: elements.length };
  });

  await browser.close();

  console.log(`結果: ${JSON.stringify(products, null, 2)}`);
  console.log(`[メルカリ] ${products.items?.length || 0}件取得`);

  return products.items || [];
}

// テスト実行
(async () => {
  try {
    const results = await scrapeMercari('ゲーム', 'on_sale');
    console.log('最終結果:', results.length, '件');
  } catch (error) {
    console.error('エラー:', error);
  }
})();
