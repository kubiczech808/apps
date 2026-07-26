# Hosting General Cleanup Audit

Generated: 2026-07-26 23:21:45 UTC

This audit is read-only. No hosting files were deleted or modified.
Counts are capped at 25,000 files per target to avoid hanging on huge directories.

## Connection: BTCDCA_FTP

- Status: connected to ftp.btc-dca.com
## Connection: HOSTING_FTP

- Status: connected to neuron.blueboard.cz
## Target Results

| Connection | Area | Root | Files | Directories | Capped | Note/Error |
| --- | --- | --- | ---: | ---: | --- | --- |
| BTCDCA_FTP | btcdca codex backups | `.codex-backups` | 128 | 32 | no | Rollback backups; keep latest or download before removal. |
| HOSTING_FTP | email-campaign root | `www/email-campaign` | 13 | 4 | no | Informational scan capped for root. |
| HOSTING_FTP | trading root | `www/trading` | 10 | 2 | no | Informational scan capped for root. |
| HOSTING_FTP | trading root | `osobnizkusenosti_cz/www/trading` | 4 | 1 | no | Informational scan capped for root. |
| BTCDCA_FTP | trading node_modules | `www/trading/node_modules` | 0 | 0 | no | cwd failed: 550 trading: No such file or directory |
| BTCDCA_FTP | email-campaign node_modules | `www/email-campaign/node_modules` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| BTCDCA_FTP | trading .git | `www/trading/.git` | 0 | 0 | no | cwd failed: 550 trading: No such file or directory |
| BTCDCA_FTP | email-campaign .git | `www/email-campaign/.git` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| BTCDCA_FTP | trading npm cache | `www/trading/.npm` | 0 | 0 | no | cwd failed: 550 trading: No such file or directory |
| BTCDCA_FTP | email-campaign npm cache | `www/email-campaign/.npm` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| BTCDCA_FTP | trading cache | `www/trading/cache` | 0 | 0 | no | cwd failed: 550 trading: No such file or directory |
| BTCDCA_FTP | email-campaign cache | `www/email-campaign/cache` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| BTCDCA_FTP | email-campaign storage cache | `www/email-campaign/storage/cache` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| BTCDCA_FTP | email-campaign storage logs | `www/email-campaign/storage/logs` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| BTCDCA_FTP | email-campaign vendor | `www/email-campaign/vendor` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| BTCDCA_FTP | trading tools | `www/trading/tools` | 0 | 0 | no | cwd failed: 550 trading: No such file or directory |
| BTCDCA_FTP | trading root | `www/trading` | 0 | 0 | no | cwd failed: 550 trading: No such file or directory |
| BTCDCA_FTP | email-campaign root | `www/email-campaign` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| HOSTING_FTP | trading node_modules | `www/trading/node_modules` | 0 | 0 | no | cwd failed: 550 node_modules: No such file or directory |
| HOSTING_FTP | email-campaign node_modules | `www/email-campaign/node_modules` | 0 | 0 | no | cwd failed: 550 node_modules: No such file or directory |
| HOSTING_FTP | trading .git | `www/trading/.git` | 0 | 0 | no | cwd failed: 550 .git: No such file or directory |
| HOSTING_FTP | email-campaign .git | `www/email-campaign/.git` | 0 | 0 | no | cwd failed: 550 .git: No such file or directory |
| HOSTING_FTP | trading npm cache | `www/trading/.npm` | 0 | 0 | no | cwd failed: 550 .npm: No such file or directory |
| HOSTING_FTP | email-campaign npm cache | `www/email-campaign/.npm` | 0 | 0 | no | cwd failed: 550 .npm: No such file or directory |
| HOSTING_FTP | trading cache | `www/trading/cache` | 0 | 0 | no | cwd failed: 550 cache: No such file or directory |
| HOSTING_FTP | email-campaign cache | `www/email-campaign/cache` | 0 | 0 | no | cwd failed: 550 cache: No such file or directory |
| HOSTING_FTP | email-campaign storage cache | `www/email-campaign/storage/cache` | 0 | 0 | no | cwd failed: 550 cache: No such file or directory |
| HOSTING_FTP | email-campaign storage logs | `www/email-campaign/storage/logs` | 0 | 0 | no | cwd failed: 550 logs: No such file or directory |
| HOSTING_FTP | email-campaign vendor | `www/email-campaign/vendor` | 0 | 0 | no | cwd failed: 550 vendor: No such file or directory |
| HOSTING_FTP | trading tools | `www/trading/tools` | 0 | 0 | no | cwd failed: 550 tools: No such file or directory |
| HOSTING_FTP | btcdca codex backups | `.codex-backups` | 0 | 0 | no | cwd failed: 550 .codex-backups: No such file or directory |
| HOSTING_FTP | trading node_modules | `osobnizkusenosti_cz/www/trading/node_modules` | 0 | 0 | no | cwd failed: 550 node_modules: No such file or directory |
| HOSTING_FTP | email-campaign node_modules | `osobnizkusenosti_cz/www/email-campaign/node_modules` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| HOSTING_FTP | trading .git | `osobnizkusenosti_cz/www/trading/.git` | 0 | 0 | no | cwd failed: 550 .git: No such file or directory |
| HOSTING_FTP | email-campaign .git | `osobnizkusenosti_cz/www/email-campaign/.git` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| HOSTING_FTP | trading npm cache | `osobnizkusenosti_cz/www/trading/.npm` | 0 | 0 | no | cwd failed: 550 .npm: No such file or directory |
| HOSTING_FTP | email-campaign npm cache | `osobnizkusenosti_cz/www/email-campaign/.npm` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| HOSTING_FTP | trading cache | `osobnizkusenosti_cz/www/trading/cache` | 0 | 0 | no | cwd failed: 550 cache: No such file or directory |
| HOSTING_FTP | email-campaign cache | `osobnizkusenosti_cz/www/email-campaign/cache` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| HOSTING_FTP | email-campaign storage cache | `osobnizkusenosti_cz/www/email-campaign/storage/cache` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| HOSTING_FTP | email-campaign storage logs | `osobnizkusenosti_cz/www/email-campaign/storage/logs` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| HOSTING_FTP | email-campaign vendor | `osobnizkusenosti_cz/www/email-campaign/vendor` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| HOSTING_FTP | trading tools | `osobnizkusenosti_cz/www/trading/tools` | 0 | 0 | no | cwd failed: 550 tools: No such file or directory |
| HOSTING_FTP | email-campaign root | `osobnizkusenosti_cz/www/email-campaign` | 0 | 0 | no | cwd failed: 550 email-campaign: No such file or directory |
| HOSTING_FTP | btcdca codex backups | `osobnizkusenosti_cz/.codex-backups` | 0 | 0 | no | cwd failed: 550 .codex-backups: No such file or directory |

## Highest-Confidence Removable Candidates

| Connection | Root | Files | Directories | Capped | Reason |
| --- | --- | ---: | ---: | --- | --- |
| BTCDCA_FTP | `.codex-backups` | 128 | 32 | no | Rollback backups; keep latest or download before removal. |

## Detail: BTCDCA_FTP / btcdca codex backups

- Root: `.codex-backups`
- Files: 128
- Directories: 32

| Extension | Files |
| --- | ---: |
| `.php` | 64 |
| `.htaccess` | 44 |
| `.css` | 12 |
| `.js` | 8 |

### Samples

- `.codex-backups/btcdca-auth/28747216066-1/app-custom.css`
- `.codex-backups/btcdca-auth/28747216066-1/app-index.php`
- `.codex-backups/btcdca-auth/28747216066-1/app.htaccess`
- `.codex-backups/btcdca-auth/28747216066-1/app.js`
- `.codex-backups/btcdca-auth/28747216066-1/custom.css`
- `.codex-backups/btcdca-auth/28747216066-1/login-user.php`
- `.codex-backups/btcdca-auth/28747216066-1/main.js`
- `.codex-backups/btcdca-auth/28747216066-1/root.htaccess`
- `.codex-backups/btcdca-auth/28747216066-1/signup-user.php`
- `.codex-backups/btcdca-auth/28740125135-1/app-custom.css`
- `.codex-backups/btcdca-auth/28740125135-1/app-index.php`
- `.codex-backups/btcdca-auth/28740125135-1/app.htaccess`
- `.codex-backups/btcdca-auth/28740125135-1/custom.css`
- `.codex-backups/btcdca-auth/28740125135-1/login-user.php`
- `.codex-backups/btcdca-auth/28740125135-1/main.js`
- `.codex-backups/btcdca-auth/28740125135-1/root.htaccess`
- `.codex-backups/btcdca-auth/28740125135-1/signup-user.php`
- `.codex-backups/btcdca-auth/28740059600-1/app-custom.css`
- `.codex-backups/btcdca-auth/28740059600-1/app-index.php`
- `.codex-backups/btcdca-auth/28740059600-1/app.htaccess`
- `.codex-backups/btcdca-auth/28740059600-1/custom.css`
- `.codex-backups/btcdca-auth/28740059600-1/login-user.php`
- `.codex-backups/btcdca-auth/28740059600-1/main.js`
- `.codex-backups/btcdca-auth/28740059600-1/root.htaccess`
- `.codex-backups/btcdca-auth/28740059600-1/signup-user.php`

## Detail: HOSTING_FTP / email-campaign root

- Root: `www/email-campaign`
- Files: 13
- Directories: 4

| Extension | Files |
| --- | ---: |
| `.php` | 5 |
| `.json` | 1 |
| `.htaccess` | 1 |
| `.md` | 1 |
| `.sqlite` | 1 |
| `.csv` | 1 |
| `.css` | 1 |
| `.js` | 1 |
| `.png` | 1 |

### Samples

- `www/email-campaign/.ftp-deploy-sync-state.json`
- `www/email-campaign/.htaccess`
- `www/email-campaign/README.md`
- `www/email-campaign/config.example.php`
- `www/email-campaign/config.php`
- `www/email-campaign/index.php`
- `www/email-campaign/storage/app.sqlite`
- `www/email-campaign/storage/imports/import-18-firmy_masaze.xlsx---pro-automatizaci-2-.csv`
- `www/email-campaign/src/Database.php`
- `www/email-campaign/src/SmtpMailer.php`
- `www/email-campaign/assets/app.css`
- `www/email-campaign/assets/app.js`
- `www/email-campaign/assets/landing-hero.png`

## Detail: HOSTING_FTP / trading root

- Root: `www/trading`
- Files: 10
- Directories: 2

| Extension | Files |
| --- | ---: |
| `.json` | 4 |
| `.php` | 2 |
| `.htaccess` | 1 |
| `.html` | 1 |
| `.css` | 1 |
| `.js` | 1 |

### Samples

- `www/trading/.htaccess`
- `www/trading/api.php`
- `www/trading/config.php`
- `www/trading/index.html`
- `www/trading/data/.live-sync-request.json`
- `www/trading/data/live-execution-state.json`
- `www/trading/data/live-state.json`
- `www/trading/data/paper-state.json`
- `www/trading/assets/app.css`
- `www/trading/assets/app.js`

## Detail: HOSTING_FTP / trading root

- Root: `osobnizkusenosti_cz/www/trading`
- Files: 4
- Directories: 1

| Extension | Files |
| --- | ---: |
| `.json` | 1 |
| `.html` | 1 |
| `.css` | 1 |
| `.js` | 1 |

### Samples

- `osobnizkusenosti_cz/www/trading/.ftp-deploy-sync-state.json`
- `osobnizkusenosti_cz/www/trading/index.html`
- `osobnizkusenosti_cz/www/trading/assets/app.css`
- `osobnizkusenosti_cz/www/trading/assets/app.js`

## Audit Runtime

- Duration: 108.4s
