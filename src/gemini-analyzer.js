const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Client } = require('pg');

async function geminiAnalyze() {
  console.log('[Gemini分析] 開始...');
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    await client.connect();
    console.log('[DB] 接続成功');
    
    const { rows } = await client.query(`
      SELECT 
        category,
        status,
        price,
        title,
        EXTRACT(EPOCH FROM (sold_at - created_at))/3600 as hours_to_sell,
        TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') as created_at
      FROM products
      WHERE created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
      LIMIT 1000
    `);
    
    await client.end();
    console.log(`[DB] ${rows.length}件のデータ取得`);
    
    if (rows.length === 0) {
      console.log('[警告] データが0件です。');
      return;
    }
    
    const summary = {
      total_items: rows.length,
      sold_items: rows.filter(r => r.status === 'SOLD').length,
      on_sale_items: rows.filter(r => r.status === '販売中').length,
      categories: [...new Set(rows.map(r => r.category))].slice(0, 20),
      sample_data: rows.slice(0, 100)
    };
    
    console.log('[統計] 合計:', summary.total_items, '件');
    console.log('[統計] SOLD:', summary.sold_items, '件');
    console.log('[統計] 販売中:', summary.on_sale_items, '件');
    
    // プロンプトチェック
    if (!process.env.GEMINI_PROMPT) {
      console.error('[エラー] GEMINI_PROMPTが設定されていません');
      console.log('\n以下の変数が利用可能です：');
      console.log('  {{total_items}} - 合計件数');
      console.log('  {{sold_items}} - 売れた件数');
      console.log('  {{on_sale_items}} - 販売中件数');
      console.log('  {{categories_count}} - カテゴリ数');
      console.log('  {{categories}} - カテゴリ一覧');
      console.log('  {{sample_data}} - サンプルデータ（JSON）');
      return;
    }
    
    if (!process.env.GEMINI_API_KEY) {
      console.error('[エラー] GEMINI_API_KEYが設定されていません');
      return;
    }
    
    // プロンプト変数を置換
    const prompt = process.env.GEMINI_PROMPT
      .replace(/{{total_items}}/g, summary.total_items)
      .replace(/{{sold_items}}/g, summary.sold_items)
      .replace(/{{on_sale_items}}/g, summary.on_sale_items)
      .replace(/{{categories_count}}/g, summary.categories.length)
      .replace(/{{categories}}/g, summary.categories.join(', '))
      .replace(/{{sample_data}}/g, JSON.stringify(summary.sample_data, null, 2));
    
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-flash',
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
      }
    });
    
    console.log('[Gemini] 分析リクエスト送信中...');
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    
    console.log('\n' + '='.repeat(80));
    console.log('📊 Gemini分析レポート');
    console.log('='.repeat(80) + '\n');
    console.log(text);
    console.log('\n' + '='.repeat(80));
    
    const fs = require('fs');
    const date = new Date().toISOString().split('T')[0];
    const filename = `analysis-${date}.md`;
    fs.writeFileSync(filename, `# メルカリ分析レポート - ${date}\n\n${text}`);
    console.log(`\n[保存] レポートを ${filename} に保存しました`);
    
  } catch (error) {
    console.error('[エラー]', error.message);
    if (error.response) {
      console.error('[詳細]', error.response.data);
    }
  }
}

geminiAnalyze().then(() => {
  console.log('\n✅ 分析完了!');
  process.exit(0);
}).catch(error => {
  console.error('❌ エラー:', error);
  process.exit(1);
});
