# BTC-DCA Hosting Cleanup Audit

Generated: 2026-07-26 23:05:15 UTC

This audit is read-only. No hosting files were deleted or modified.
It focuses on likely cleanup areas, so totals below are not the full hosting account file count.

## Summary

- Targeted files counted: 275
- Targeted directories counted: 43
- Scan duration: 145.9s
- Listing errors captured: 17

## Target Roots

| Area | Root | Files | Directories | Duration | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| Codex deploy backups | `.codex-backups` | 128 | 32 | 57.7s | Potentially removable after keeping or downloading the newest rollback set. |
| UAG generated uploads | `www/wp-content/uploads/uag-plugin` | 102 | 4 | 10.9s | Generated/template support files; review plugin usage first. |
| Astra block template cache | `www/wp-content/uploads/ast-block-templates-json` | 43 | 0 | 1.9s | Template JSON cache, usually regenerable. |
| WordPress cache | `www/wp-content/cache` | 2 | 1 | 3.7s | Usually regenerable cache data. |
| WordPress upgrade temp | `www/wp-content/upgrade` | 0 | 0 | 1.8s | Temporary WordPress upgrade files; safe only when no update is running. |
| WordPress upgrade temp backup | `www/wp-content/upgrade-temp-backup` | 0 | 0 | 1.8s | Temporary plugin/theme backup area created by WordPress updates. |
| All-in-One WP Migration backups | `www/wp-content/ai1wm-backups` | 0 | 0 | 0.0s | Missing or not listable. |
| Uploads cache | `www/wp-content/uploads/cache` | 0 | 0 | 0.0s | Missing or not listable. |
| Elementor uploads | `www/wp-content/uploads/elementor` | 0 | 1 | 4.0s | Mostly generated CSS/assets, but review before deleting the whole tree. |
| Uploads 2022 | `www/wp-content/uploads/2022` | 0 | 5 | 25.3s | Media library files; not a safe automatic cleanup target. |
| Uploads 2023 | `www/wp-content/uploads/2023` | 0 | 0 | 0.0s | Missing or not listable. |
| Uploads 2024 | `www/wp-content/uploads/2024` | 0 | 0 | 0.0s | Missing or not listable. |
| Uploads 2025 | `www/wp-content/uploads/2025` | 0 | 0 | 0.0s | Missing or not listable. |
| Uploads 2026 | `www/wp-content/uploads/2026` | 0 | 0 | 0.0s | Missing or not listable. |
| WordPress plugins | `www/wp-content/plugins` | 0 | 0 | 0.0s | Missing or not listable. |
| WordPress themes | `www/wp-content/themes` | 0 | 0 | 0.0s | Missing or not listable. |
| BTC-DCA app | `www/app` | 0 | 0 | 0.0s | Missing or not listable. |
| AI directory | `www/ai` | 0 | 0 | 0.0s | Missing or not listable. |
| Shared assets | `www/assets` | 0 | 0 | 0.0s | Missing or not listable. |
| Includes | `www/includes` | 0 | 0 | 0.0s | Missing or not listable. |

## Cleanup Candidate Buckets

| Bucket | Matching files | Practical risk |
| --- | ---: | --- |
| uag/astra template cache | 145 | Low/medium; verify plugin usage. |
| codex backups | 128 | Low if newest rollback set is kept or downloaded first. |
| wp cache | 2 | Low; cache should regenerate. |

## Detail: Codex deploy backups

- Root: `.codex-backups`
- Files: 128
- Directories: 32
- Listing methods: MLSD=33

## Codex deploy backups - Largest Immediate Children

| Child | Files |
| --- | ---: |
| `btcdca-auth` | 128 |

## Codex deploy backups - Top Extensions

| Extension | Files |
| --- | ---: |
| `.php` | 64 |
| `.htaccess` | 44 |
| `.css` | 12 |
| `.js` | 8 |

### Codex deploy backups - File Samples

- `.codex-backups/btcdca-auth/28003453802-1/login-user.php`
- `.codex-backups/btcdca-auth/28003453802-1/app.htaccess`
- `.codex-backups/btcdca-auth/28003453802-1/signup-user.php`
- `.codex-backups/btcdca-auth/27969963963-1/app.htaccess`
- `.codex-backups/btcdca-auth/27969963963-1/signup-user.php`
- `.codex-backups/btcdca-auth/27969963963-1/login-user.php`
- `.codex-backups/btcdca-auth/28006108218-1/signup-user.php`
- `.codex-backups/btcdca-auth/28006108218-1/login-user.php`
- `.codex-backups/btcdca-auth/28006108218-1/root.htaccess`
- `.codex-backups/btcdca-auth/28006108218-1/app.htaccess`
- `.codex-backups/btcdca-auth/27895566099-1/app.htaccess`
- `.codex-backups/btcdca-auth/27895566099-1/login-user.php`
- `.codex-backups/btcdca-auth/27895566099-1/signup-user.php`
- `.codex-backups/btcdca-auth/27931041315-1/login-user.php`
- `.codex-backups/btcdca-auth/27931041315-1/signup-user.php`
- `.codex-backups/btcdca-auth/27931041315-1/app.htaccess`
- `.codex-backups/btcdca-auth/28005734161-1/app.htaccess`
- `.codex-backups/btcdca-auth/28005734161-1/signup-user.php`
- `.codex-backups/btcdca-auth/28005734161-1/login-user.php`
- `.codex-backups/btcdca-auth/27970922279-1/login-user.php`
- `.codex-backups/btcdca-auth/27970922279-1/app.htaccess`
- `.codex-backups/btcdca-auth/27970922279-1/signup-user.php`
- `.codex-backups/btcdca-auth/28730975220-1/app.htaccess`
- `.codex-backups/btcdca-auth/28730975220-1/main.js`
- `.codex-backups/btcdca-auth/28730975220-1/root.htaccess`
- `.codex-backups/btcdca-auth/28730975220-1/signup-user.php`
- `.codex-backups/btcdca-auth/28730975220-1/login-user.php`
- `.codex-backups/btcdca-auth/28730975220-1/custom.css`
- `.codex-backups/btcdca-auth/27966426650-1/signup-user.php`
- `.codex-backups/btcdca-auth/27966426650-1/app.htaccess`

## Detail: UAG generated uploads

- Root: `www/wp-content/uploads/uag-plugin`
- Files: 102
- Directories: 4
- Listing methods: MLSD=5

## UAG generated uploads - Largest Immediate Children

| Child | Files |
| --- | ---: |
| `assets` | 100 |
| `index.html` | 1 |
| `custom-style-blocks.css` | 1 |

## UAG generated uploads - Top Extensions

| Extension | Files |
| --- | ---: |
| `.css` | 99 |
| `.html` | 2 |
| `.js` | 1 |

### UAG generated uploads - File Samples

- `www/wp-content/uploads/uag-plugin/index.html`
- `www/wp-content/uploads/uag-plugin/custom-style-blocks.css`
- `www/wp-content/uploads/uag-plugin/assets/index.html`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-945.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-776.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-979.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-514.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-842.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-968.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-914.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-1020.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-767.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-1029.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-877.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-852.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-883.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-1005.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-745.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-936.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-860.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-867.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-983.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-955.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-927.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-1026.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-761.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-1014.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-872.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-951.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-807.css`

## Detail: Astra block template cache

- Root: `www/wp-content/uploads/ast-block-templates-json`
- Files: 43
- Directories: 0
- Listing methods: MLSD=1

## Astra block template cache - Largest Immediate Children

| Child | Files |
| --- | ---: |
| `ast-block-templates-blocks-13.json` | 1 |
| `ast-block-templates-blocks-22.json` | 1 |
| `ast-block-templates-blocks-17.json` | 1 |
| `ast-block-templates-sites-12.json` | 1 |
| `ast-block-templates-blocks-2.json` | 1 |
| `ast-block-templates-sites-2.json` | 1 |
| `ast-block-templates-blocks-6.json` | 1 |
| `ast-block-templates-sites-6.json` | 1 |
| `.htaccess` | 1 |
| `ast-block-templates-sites-3.json` | 1 |
| `index.html` | 1 |
| `ast-block-templates-blocks-3.json` | 1 |
| `ast-block-templates-sites-7.json` | 1 |
| `ast-block-templates-blocks-7.json` | 1 |
| `ast-block-templates-blocks-12.json` | 1 |
| `ast-block-templates-customizer-css.json` | 1 |
| `ast-block-templates-blocks-23.json` | 1 |
| `ast-block-templates-blocks-16.json` | 1 |
| `ast-block-templates-blocks-18.json` | 1 |
| `ast-block-templates-sites-11.json` | 1 |
| `ast-block-templates-blocks-1.json` | 1 |
| `ast-block-templates-sites-1.json` | 1 |
| `ast-block-templates-blocks-5.json` | 1 |
| `ast-block-templates-sites-5.json` | 1 |
| `ast-block-templates-blocks-10.json` | 1 |

## Astra block template cache - Top Extensions

| Extension | Files |
| --- | ---: |
| `.json` | 41 |
| `.htaccess` | 1 |
| `.html` | 1 |

### Astra block template cache - File Samples

- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-13.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-22.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-17.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-sites-12.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-2.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-sites-2.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-6.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-sites-6.json`
- `www/wp-content/uploads/ast-block-templates-json/.htaccess`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-sites-3.json`
- `www/wp-content/uploads/ast-block-templates-json/index.html`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-3.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-sites-7.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-7.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-12.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-customizer-css.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-23.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-16.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-18.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-sites-11.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-1.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-sites-1.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-5.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-sites-5.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-10.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-sites-9.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-21.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-9.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-categories.json`
- `www/wp-content/uploads/ast-block-templates-json/ast-block-templates-blocks-14.json`

## Detail: WordPress cache

- Root: `www/wp-content/cache`
- Files: 2
- Directories: 1
- Listing methods: MLSD=2

## WordPress cache - Largest Immediate Children

| Child | Files |
| --- | ---: |
| `wpsso` | 2 |

## WordPress cache - Top Extensions

| Extension | Files |
| --- | ---: |
| `.htaccess` | 1 |
| `.php` | 1 |

### WordPress cache - File Samples

- `www/wp-content/cache/wpsso/.htaccess`
- `www/wp-content/cache/wpsso/index.php`

## Detail: WordPress upgrade temp

- Root: `www/wp-content/upgrade`
- Files: 0
- Directories: 0
- Listing methods: MLSD=1

## Detail: WordPress upgrade temp backup

- Root: `www/wp-content/upgrade-temp-backup`
- Files: 0
- Directories: 0
- Listing methods: MLSD=1

## Detail: All-in-One WP Migration backups

- Root: `www/wp-content/ai1wm-backups`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: Uploads cache

- Root: `www/wp-content/uploads/cache`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: Elementor uploads

- Root: `www/wp-content/uploads/elementor`
- Files: 0
- Directories: 1
- Listing methods: MLSD=2

## Detail: Uploads 2022

- Root: `www/wp-content/uploads/2022`
- Files: 0
- Directories: 5
- Listing methods: MLSD=1

## Detail: Uploads 2023

- Root: `www/wp-content/uploads/2023`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: Uploads 2024

- Root: `www/wp-content/uploads/2024`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: Uploads 2025

- Root: `www/wp-content/uploads/2025`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: Uploads 2026

- Root: `www/wp-content/uploads/2026`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: WordPress plugins

- Root: `www/wp-content/plugins`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: WordPress themes

- Root: `www/wp-content/themes`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: BTC-DCA app

- Root: `www/app`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: AI directory

- Root: `www/ai`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: Shared assets

- Root: `www/assets`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Detail: Includes

- Root: `www/includes`
- Files: 0
- Directories: 0
- Listing methods: n/a

## Cleanup Candidate Samples

### codex backups

- `.codex-backups/btcdca-auth/28003453802-1/login-user.php`
- `.codex-backups/btcdca-auth/28003453802-1/app.htaccess`
- `.codex-backups/btcdca-auth/28003453802-1/signup-user.php`
- `.codex-backups/btcdca-auth/27969963963-1/app.htaccess`
- `.codex-backups/btcdca-auth/27969963963-1/signup-user.php`
- `.codex-backups/btcdca-auth/27969963963-1/login-user.php`
- `.codex-backups/btcdca-auth/28006108218-1/signup-user.php`
- `.codex-backups/btcdca-auth/28006108218-1/login-user.php`
- `.codex-backups/btcdca-auth/28006108218-1/root.htaccess`
- `.codex-backups/btcdca-auth/28006108218-1/app.htaccess`
- `.codex-backups/btcdca-auth/27895566099-1/app.htaccess`
- `.codex-backups/btcdca-auth/27895566099-1/login-user.php`
- `.codex-backups/btcdca-auth/27895566099-1/signup-user.php`
- `.codex-backups/btcdca-auth/27931041315-1/login-user.php`
- `.codex-backups/btcdca-auth/27931041315-1/signup-user.php`
- `.codex-backups/btcdca-auth/27931041315-1/app.htaccess`
- `.codex-backups/btcdca-auth/28005734161-1/app.htaccess`
- `.codex-backups/btcdca-auth/28005734161-1/signup-user.php`
- `.codex-backups/btcdca-auth/28005734161-1/login-user.php`
- `.codex-backups/btcdca-auth/27970922279-1/login-user.php`
- `.codex-backups/btcdca-auth/27970922279-1/app.htaccess`
- `.codex-backups/btcdca-auth/27970922279-1/signup-user.php`
- `.codex-backups/btcdca-auth/28730975220-1/app.htaccess`
- `.codex-backups/btcdca-auth/28730975220-1/main.js`
- `.codex-backups/btcdca-auth/28730975220-1/root.htaccess`
- `.codex-backups/btcdca-auth/28730975220-1/signup-user.php`
- `.codex-backups/btcdca-auth/28730975220-1/login-user.php`
- `.codex-backups/btcdca-auth/28730975220-1/custom.css`
- `.codex-backups/btcdca-auth/27966426650-1/signup-user.php`
- `.codex-backups/btcdca-auth/27966426650-1/app.htaccess`

### wp cache

- `www/wp-content/cache/wpsso/.htaccess`
- `www/wp-content/cache/wpsso/index.php`

### uag/astra template cache

- `www/wp-content/uploads/uag-plugin/index.html`
- `www/wp-content/uploads/uag-plugin/custom-style-blocks.css`
- `www/wp-content/uploads/uag-plugin/assets/index.html`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-945.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-776.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-979.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-514.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-842.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-968.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-914.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-1020.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-767.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-1029.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-877.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-852.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-883.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-1005.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-745.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-936.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-860.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-867.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-983.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-955.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-927.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-1026.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-761.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-1014.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-872.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-951.css`
- `www/wp-content/uploads/uag-plugin/assets/1000/uag-css-807.css`

## Listing Errors

- `www/wp-content/ai1wm-backups: cwd failed: 550 ai1wm-backups: No such file or directory`
- `www/wp-content/uploads/cache: cwd failed: 550 cache: No such file or directory`
- `www/wp-content/uploads/2022/10: MLSD='utf-8' codec can't decode byte 0xb7 in position 529: invalid start byte; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/wp-content/uploads/2022/09: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/wp-content/uploads/2022/12: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/wp-content/uploads/2022/08: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/wp-content/uploads/2022/11: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/wp-content/uploads/2023: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/wp-content/uploads/2024: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/wp-content/uploads/2025: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/wp-content/uploads/2026: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/wp-content/plugins: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/wp-content/themes: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/app: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/ai: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/assets: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`
- `www/includes: MLSD=200 Type set to A; LIST=200 Type set to A; NLST=200 Type set to A`

