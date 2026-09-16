# BTC-DCA WordPress retirement preflight

Read-only production inventory. No files or database records were changed.
FTP values describe only the directory boundary; recursive counting is intentionally avoided because it can stall on this hosting server.

## FTP inventory

| Path | Files | Directories | Listed bytes | Warnings |
| --- | ---: | ---: | ---: | --- |
| `www/wp-admin` | 95 | 7 | 962,032 | - |
| `www/wp-includes` | 260 | 32 | 8,107,759 | - |
| `www/wp-content` | 2 | 7 | 2,207 | - |
| `www/learn-center` | 0 | 0 | 0 | Not accessible: www/learn-center |

## Database inventory

MySQL server reachable: `ERROR: ERROR 2002 (HY000): Can't connect to local MySQL server through socket '/var/run/mysqld/mysqld.sock' (2)`.

WordPress table prefix was not found in `wp-config.php`; do not delete database tables until this is resolved.

```text
ERROR: ERROR 2002 (HY000): Can't connect to local MySQL server through socket '/var/run/mysqld/mysqld.sock' (2)
```

### Homepage source matches

File not available over FTP.

### Immediate `www` directory entries

```text
file wp-config-sample.php (3339 bytes)
file wp-comments-post.php (2323 bytes)
file wp-login.php (52536 bytes)
dir  ai (? bytes)
dir  app (? bytes)
file password-changed.php (9417 bytes)
file signup-user.php (17137 bytes)
file wp-mail.php (8727 bytes)
dir  wp-includes (? bytes)
dir  bot (? bytes)
file wp-trackback.php (5396 bytes)
dir  wp-admin (? bytes)
file readme.html (7407 bytes)
file wp-cron.php (5617 bytes)
file btcdca-google-login.php (1454 bytes)
dir  wp-content (? bytes)
file .htaccess (1571 bytes)
file robots.txt (291 bytes)
file user-otp.php (10646 bytes)
file wp-blog-header.php (351 bytes)
file wp-signup.php (35081 bytes)
file btcdca-google-token-login.php (2311 bytes)
file xmlrpc.php (3205 bytes)
file index.html (9247 bytes)
dir  old_scripts (? bytes)
file logout-user.php (102 bytes)
dir  includes (? bytes)
dir  openclaw (? bytes)
file btcdca-google-callback.php (17094 bytes)
dir  assets (? bytes)
file login-user.php (14153 bytes)
dir  .well-known (? bytes)
file index.php (405 bytes)
file wp-links-opml.php (2493 bytes)
file sitemap.xml (8307 bytes)
dir  blogger-app (? bytes)
file license.txt (19903 bytes)
dir  php (? bytes)
file wp-load.php (3937 bytes)
file reset-code.php (10159 bytes)
file wp-activate.php (7718 bytes)
dir  poly (? bytes)
file wp-config.php (3422 bytes)
file new-password.php (10380 bytes)
file dca-calculator.php (67003 bytes)
file wp-settings.php (33152 bytes)
dir  .claude (? bytes)
file forgot-password.php (10039 bytes)
```

### Root .htaccess matches

File not available over FTP.

### robots.txt matches

File not available over FTP.

## Required removal contract

The removal workflow must only run after this report identifies the WordPress prefix and exact public homepage markers.
It must first upload the static guides and copied guide media, export only the WordPress-prefixed tables as an Actions artifact, verify the three public guide URLs, and only then remove WordPress files and WordPress tables.
