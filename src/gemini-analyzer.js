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
    
    // 期間を環境変数で調整可能に（デフォルト7日間）
    const days = process.env.ANALYSIS_DAYS || 7;
    
    const { rows } = await client.query(`
      SELECT 
        category,
        status,
        price,
        title,
        EXTRACT(EPOCH FROM (sold_at - created_at))/3600 as hours_to_sell,
        TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') as created_at
      FROM products
      WHERE created_at > NOW() - INTERVAL '${days} days'
      ORDER BY created_at DESC
    `);
    
    await client.end();
    console.log(`[DB] ${rows.length}件のデータ取得（過去${days}日間）`);
    
    if (rows.length === 0) {
      console.log('[警告] データが0件です。');
      return;
    }
    
    // サンプル件数を環境変数で調整可能に（デフォルト1000件、0=全件）
    const sampleSize = parseInt(process.env.GEMINI_SAMPLE_SIZE || '1000');
    const sampleData = sampleSize === 0 ? rows : rows.slice(0, sampleSize);
    
    console.log(`[サンプル] ${sampleData.length}件を分析に使用`);
    
    // データサイズを計算（警告用）
    const dataSize = JSON.stringify(sampleData).length;
    const estimatedTokens = Math.round(dataSize / 4); // 大雑把な見積もり
    console.log(`[推定] データサイズ: ${(dataSize / 1024).toFixed(1)}KB, トークン数: 約${estimatedTokens.toLocaleString()}`);
    
    if (estimatedTokens > 900000) {
      console.warn('[警告] トークン数が多すぎます（100万トークン制限）。GEMINI_SAMPLE_SIZEを小さくしてください。');
      return;
    }
    
    const summary = {
      total_items: rows.length,
      sold_items: rows.filter(r => r.status === 'SOLD').length,
      on_sale_items: rows.filter(r => r.status === '販売中').length,
      categories: [...new Set(rows.map(r => r.category))].slice(0, 50), // カテゴリも増やす
      sample_data: sampleData,
      sample_size: sampleData.length
    };
    
    console.log('[統計] 合計:', summary.total_items, '件');
    console.log('[統計] SOLD:', summary.sold_items, '件');
    console.log('[統計] 販売中:', summary.on_sale_items, '件');
    console.log('[統計] カテゴリ数:', summary.categories.length, '種類');
    
    if (!process.env.GEMINI_PROMPT) {
      console.error('[エラー] GEMINI_PROMPTが設定されていません');
      console.log('\n以下の変数が利用可能です：');
      console.log('  {{total_items}} - 合計件数');
      console.log('  {{sold_items}} - 売れた件数');
      console.log('  {{on_sale_items}} - 販売中件数');
      console.log('  {{categories_count}} - カテゴリ数');
      console.log('  {{categories}} - カテゴリ一覧');
      console.log('  {{sample_data}} - サンプルデータ（JSON）');
      console.log('  {{sample_size}} - サンプルデータ件数');
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
      .replace(/{{sample_data}}/g, JSON.stringify(summary.sample_data, null, 2))
      .replace(/{{sample_size}}/g, summary.sample_size);
    
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 利用可能なモデル一覧を取得
try {
  const models = await genAI.listModels();
  console.log('[利用可能なモデル]');
  models.forEach(m => console.log(`  - ${m.name}`));
} catch (e) {
  console.log('[モデル一覧取得エラー]', e.message);
}
    
const model = genAI.getGenerativeModel({ 
  model: 'gemini-1.5-flash-latest',  // ← -latest を追加
  generationConfig: {
    temperature: 0.7,
    maxOutputTokens: 4096,
  }
});
    
    console.log('[Gemini] 分析リクエスト送信中...');
    const startTime = Date.now();
    
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Gemini] 分析完了（${elapsed}秒）`);
    
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
