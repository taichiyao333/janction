/**
 * さくらドメインパネルでネームサーバーを変更（2FA対応版）
 */
const { chromium } = require('playwright-core');
const readline = require('readline');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NS1 = 'kimora.ns.cloudflare.com';
const NS2 = 'noel.ns.cloudflare.com';
const MEMBER_ID = 'ecu60153';
const PASSWORD = 'METAmeta@123123';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitForEnter(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(msg, () => { rl.close(); resolve(); });
  });
}

async function main() {
  console.log('\n🚀 さくらネームサーバー変更ツール（2FA対応版）起動...\n');

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--no-sandbox', '--start-maximized']
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    // Step 1: ログイン
    console.log('📍 Step 1: さくらにログイン中...');
    await page.goto('https://secure.sakura.ad.jp/auth/login', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(500);

    await page.fill('input[name="membercd"]', MEMBER_ID);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('#btn-login');
    await sleep(3000);

    const currentUrl = page.url();
    console.log('現在のURL:', currentUrl);

    // 2FAページの場合
    if (currentUrl.includes('two_step') || currentUrl.includes('2fa') || currentUrl.includes('auth')) {
      console.log('\n⚠️  二段階認証が必要です！');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📱 Chromeウィンドウが開いています。');
      console.log('   メールまたは認証アプリでコードを確認して');
      console.log('   Chromeの画面に入力してください。');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      await waitForEnter('\n✅ 2FAの入力が完了したらEnterキーを押してください: ');
      await sleep(2000);
      console.log('続行します... URL:', page.url());
    }

    // Step 2: ドメイン管理パネルへ
    console.log('\n📍 Step 2: ドメイン管理パネルへ移動...');
    await page.goto('https://secure.sakura.ad.jp/domain/', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);

    const domainPageTitle = await page.title();
    console.log('ドメインページタイトル:', domainPageTitle);

    // ログインしてくださいと出た場合 = SPAの認証フロー問題
    if (domainPageTitle.includes('ログイン')) {
      console.log('⚠️  ドメインパネルにもログインが必要です。');
      console.log('   ChromeウィンドウでSAKURAIDでログインしてください。');
      await waitForEnter('ドメインパネルにログイン完了したらEnterを押してください: ');
      await sleep(2000);
    }

    // janction.netを探す
    console.log('\n📍 Step 3: janction.netを検索...');
    await sleep(2000);

    // JavaScriptでドメインリストを取得
    const domainList = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.filter(l => l.textContent.includes('janction') || l.href.includes('janction'))
                  .map(l => ({ text: l.textContent.trim(), href: l.href }));
    });
    console.log('janction関連リンク:', domainList);

    // ドメインをクリック
    if (domainList.length > 0) {
      await page.click(`a[href*="janction"], a:has-text("janction")`);
      await sleep(3000);
      console.log('janction.netをクリック! URL:', page.url());
    } else {
      console.log('⚠️  janction.netが見つかりません。');
      console.log('   Chromeウィンドウでjanction.netをクリックしてください。');
      await waitForEnter('クリック後にEnterを押してください: ');
    }

    // Step 4: ネームサーバー設定
    console.log('\n📍 Step 4: ネームサーバー設定を探す...');
    await sleep(2000);
    console.log('現在のURL:', page.url());

    // ページ内のテキストを確認
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('ページテキスト(300文字):', pageText.substring(0, 300));

    // NSリンクを探す
    const nsLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button'));
      return links.filter(l => 
        l.textContent.includes('ネームサーバー') || 
        l.textContent.includes('nameserver') ||
        l.textContent.includes('NS') ||
        l.textContent.includes('name-server')
      ).map(l => ({ text: l.textContent.trim(), href: l.href || '' }));
    });
    console.log('NSリンク:', nsLinks);

    if (nsLinks.length > 0) {
      await page.click('a:has-text("ネームサーバー"), button:has-text("ネームサーバー")');
      await sleep(2000);
    } else {
      console.log('⚠️  ネームサーバーのリンクが見つかりません。');
      console.log('   Chromeウィンドウで手動でネームサーバー設定を開いてください。');
      await waitForEnter('開いたらEnterを押してください: ');
    }

    // Step 5: 入力フィールドへの入力
    console.log('\n📍 Step 5: ネームサーバーを入力...');
    await sleep(2000);

    // 入力フィールドを全て確認
    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
        .map(el => ({
          name: el.name,
          id: el.id,
          value: el.value,
          placeholder: el.placeholder
        }));
    });
    console.log('入力フィールド:', inputs);

    // 入力フィールドにNSを入力
    let ns1done = false, ns2done = false;

    // 名前ベースで試す
    for (const input of inputs) {
      if (input.name && (input.name.includes('ns1') || input.name.includes('nameserver1') || input.name === 'ns[0]')) {
        await page.fill(`[name="${input.name}"]`, NS1);
        console.log(`✅ NS1入力完了 (${input.name}):`, NS1);
        ns1done = true;
      }
      if (input.name && (input.name.includes('ns2') || input.name.includes('nameserver2') || input.name === 'ns[1]')) {
        await page.fill(`[name="${input.name}"]`, NS2);
        console.log(`✅ NS2入力完了 (${input.name}):`, NS2);
        ns2done = true;
      }
    }

    if (!ns1done || !ns2done) {
      console.log('\n⚠️  自動入力できませんでした。');
      console.log('   Chromeウィンドウで手動でネームサーバーを変更してください:');
      console.log(`   NS1: ${NS1}`);
      console.log(`   NS2: ${NS2}`);
      await waitForEnter('変更・保存が完了したらEnterを押してください: ');
    } else {
      // 保存
      await sleep(1000);
      const saveBtn = await page.locator('button[type="submit"], input[type="submit"], button:has-text("設定"), button:has-text("保存"), button:has-text("変更"), button:has-text("確認")').first();
      if (await saveBtn.isVisible()) {
        await saveBtn.click();
        console.log('✅ 保存ボタンをクリック!');
        await sleep(3000);
      }
    }

    console.log('\n🎉 処理完了！');
    console.log('最終URL:', page.url());
    console.log('\n⏳ 30秒後にウィンドウを閉じます。確認してください...');
    await sleep(30000);

  } catch (err) {
    console.error('\n❌ エラー:', err.message);
    console.log('Chromeウィンドウに表示されている内容を確認してください。');
    await sleep(30000);
  } finally {
    await browser.close();
    console.log('完了');
  }
}

main().catch(console.error);
