import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const sourcePath = '.github/inspection/btcdca-homepage-template.php';
const targetPath = 'btcdca-static/homepage/index.html';
const affiliates = {
  2: 'https://coinmate.io?affiliate=UlhaT1ZETjZNbkJ6V0hrd1IyeERZakEzVUdaV2R3PT0',
  3: 'https://accounts.binance.com/en/register?ref=ABP939VR',
  4: 'https://www.okx.com/join/65437822',
  5: 'https://partner.bybit.com/b/BTCDCA',
  6: 'https://advanced.coinbase.com/join/RSCXAJL',
  8: 'https://partner.bybit.eu/b/ZKUSENOSTI',
};

let html = readFileSync(sourcePath, 'utf8');
html = html.slice(html.indexOf('<!DOCTYPE html>'));
html = html.replace('<html <?php language_attributes(); ?>>', '<html lang="en">');
html = html.replace('<meta charset="<?php bloginfo(\'charset\'); ?>">', '<meta charset="UTF-8">');
html = html.replace('<?php wp_head(); ?>', '');
html = html.replace('<body <?php body_class(\'btcdca-home\'); ?>>', '<body class="btcdca-home">');
html = html.replace('<?php wp_body_open(); ?>', '');
html = html.replace('<?php wp_footer(); ?>', '');

const nav = `<nav class="btcdca-nav" aria-label="Primary navigation"><ul class="btcdca-nav">
  <li><a href="/">Home</a></li><li><a href="/dca-calculator">Calculator</a></li>
  <li><a href="/#dca">DCA</a></li><li><a href="/#how-it-works">How it works</a></li>
  <li><a href="/#faq">FAQ</a></li><li class="menu-login"><a href="/login-user">Login</a></li>
</ul></nav>`;
html = html.replace(/<\?php wp_nav_menu\(\[.*?\n      \]\); \?>/s, nav);

// These blocks depend on WordPress queries/plugins and have no static equivalent.
html = html.replace(/<section class="sep bg2">\s*<div class="container">\s*<div class="section-label">Reviews<\/div>.*?<\/section>\s*/s, '');
html = html.replace(/<section class="sep">\s*<div class="container">\s*<div class="section-label">Learn Center<\/div>.*?<\/section>\s*<!-- FAQ -->/s, '<!-- FAQ -->');

html = html.replace(/<\?php echo esc_url\(ex_link\((\d+), \$ex_links\)\); \?>/g, (_match, id) => affiliates[id] || '#');
html = html.replace(/<\?php echo ex_link\((\d+), \$ex_links\); \?>/g, (_match, id) => affiliates[id] || '#');
html = html.replace(/<\?php echo home_url\('([^']*)'\); \?>/g, (_match, path) => path);
html = html.replace(/<\?php echo date\('Y'\); \?>/g, '2026');
html = html.replace(/<\?php bloginfo\('name'\); \?>/g, 'BTC DCA');

html = html.replace(/\s*<p style="margin-top:24px;font-size:13px;color:var\(--text-dim\)"><a href="\/crypto-exchanges\/">Compare all exchanges &rarr;<\/a><\/p>/, '');
html = html.replace(/<a href="\/supported-fiat-currencies\/"([^>]*)>\+ more &rarr;<\/a>/, '<span$1>+ more</span>');
html = html.replace(' <a href="/learn-center/">Learn more in our Learn Center &rarr;</a>', '');
html = html.replace('<a href="/bitcoin-dca-pricing/">Pricing page</a>', 'subscription plans');
html = html.replace(/<div class="footer-cols">.*?<\/div>\s*<\/div>\s*<div class="footer-bottom">/s, `<div class="footer-cols">
        <div class="footer-col"><h4>Product</h4><a href="/dca-calculator">DCA Calculator</a><a href="/#how-it-works">How it works</a><a href="/#faq">FAQ</a></div>
        <div class="footer-col"><h4>API setup guides</h4><a href="/btc-dca-binance-how-to-set-up-api-key/">Binance</a><a href="/btc-dca-coinmate-how-to-set-up-api-key/">Coinmate</a><a href="/btc-dca-okx-how-to-set-up-api-key/">OKX</a></div>
        <div class="footer-col"><h4>Account</h4><a href="/login-user">Login</a><a href="/dca-calculator">Sign Up</a><a href="/forgot-password">Forgot Password</a></div>
      </div>
    </div>
    <div class="footer-bottom">`);
html = html.replace(/<span><a href="\/learn-center\/">Learn Center<\/a> &middot; <a href="\/bitcoin-dca-pricing\/">Pricing<\/a> &middot; <a href="\/#faq">FAQ<\/a><\/span>/, '<span><a href="/#faq">FAQ</a> &middot; <a href="/login-user">Login</a></span>');
html = html.replace(/\.php(?=["'#])/g, '');
html = html.replace('</head>', '  <link rel="canonical" href="https://www.btc-dca.com/">\n  <meta name="generator" content="BTC DCA static homepage">\n</head>');

const forbiddenDependencies = [
  ['PHP', /<\?php/i],
  ['Learn Center', /learn center/i],
  ['Latest from the blog', /latest from the blog/i],
  ['wp-content', /wp-content/i],
  ['WordPress', /wordpress/i],
];
const remainingDependencies = forbiddenDependencies.flatMap(([label, pattern]) => {
  const match = html.match(pattern);
  return match ? [`${label}: ${html.slice(Math.max(0, match.index - 80), match.index + 160)}`] : [];
});

if (remainingDependencies.length) {
  throw new Error(`Static homepage still contains legacy dependencies:\n${remainingDependencies.join('\n')}`);
}
mkdirSync('btcdca-static/homepage', { recursive: true });
writeFileSync(targetPath, html);
console.log(`Built ${targetPath} without WordPress dependencies.`);
