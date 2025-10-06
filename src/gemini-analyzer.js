const { GoogleGenAI } = require('@google/genai');  // ← GoogleGenAI（GenerativeAIではない）
const { Client } = require('pg');

async function geminiAnalyze() {
  console.log('[Gemini分析] 開始...');
  
  if (!process.env.GEMINI_API_KEY) {
    console.error('[エラー] GEMINI_API_KEYが設定されていません');
    return;
  }
  
  const dbClient = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    await dbClient.connect();
    console.log('[DB] 接続成功');
    
    const days = process.env.ANALYSIS_DAYS || 7;
    const { rows } = await dbClient.query(`
      SELECT 
        category, status, price, title,
        EXTRACT(EPOCH FROM (sold_at - created_at))/3600 as hours_to_sell,
        TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') as created_at
      FROM products
      WHERE created_at > NOW() - INTERVAL '${days} days'
      ORDER BY created_at DESC
    `);
    
    await dbClient.end();
    console.log(`[DB] ${rows.length}件のデータ取得`);
    
    if (rows.length === 0) {
      console.log('[警告] データが0件');
      return;
    }
    
    const sampleSize = parseInt(process.env.GEMINI_SAMPLE_SIZE || '1000');
    const sampleData = sampleSize === 0 ? rows : rows.slice(0, sampleSize);
    
    const summary = {
      total_items: rows.length,
      sold_items: rows.filter(r => r.status === 'SOLD').length,
      on_sale_items: rows.filter(r => r.status === '販売中').length,
      categories: [...new Set(rows.map(r => r.category))].slice(0, 50),
      sample_data: sampleData,
      sample_size: sampleData.length
    };
    
    console.log('[統計] 合計:', summary.total_items);
    console.log('[統計] SOLD:', summary.sold_items);
    
    if (!process.env.GEMINI_PROMPT) {
      console.error('[エラー] GEMINI_PROMPTが設定されていません');
      return;
    }
    
    const prompt = process.env.GEMINI_PROMPT
      .replace(/{{total_items}}/g, summary.total_items)
      .replace(/{{sold_items}}/g, summary.sold_items)
      .replace(/{{on_sale_items}}/g, summary.on_sale_items)
      .replace(/{{categories_count}}/g, summary.categories.length)
      .replace(/{{categories}}/g, summary.categories.join(', '))
      .replace(/{{sample_data}}/g, JSON.stringify(summary.sample_data, null, 2))
      .replace(/{{sample_size}}/g, summary.sample_size);
    
    // 正しい使い方（READMEより）
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    console.log('[Gemini] リクエスト送信...');
    const startTime = Date.now();
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',  // Gemini 2.0
      contents: prompt,
    });
    
    const text = response.text;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Gemini] 完了（${elapsed}秒）`);
    
    console.log('\n' + '='.repeat(80));
    console.log('📊 Gemini分析レポート');
    console.log('='.repeat(80) + '\n');
    console.log(text);
    console.log('\n' + '='.repeat(80));
    
    const fs = require('fs');
    const date = new Date().toISOString().split('T')[0];
    const filename = `analysis-${date}.md`;
    fs.writeFileSync(filename, `# メルカリ分析レポート - ${date}\n\n${text}`);
    console.log(`\n[保存] ${filename}`);
    
  } catch (error) {
    console.error('[エラー]', error.message);
    console.error(error);
  }
}

geminiAnalyze().then(() => {
  console.log('\n✅ 完了');
  process.exit(0);
}).catch(error => {
  console.error('❌ エラー:', error);
  process.exit(1);
});
