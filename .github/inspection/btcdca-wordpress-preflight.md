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

### Root .htaccess matches

File not available over FTP.

### robots.txt matches

File not available over FTP.

## Required removal contract

The removal workflow must only run after this report identifies the WordPress prefix and exact public homepage markers.
It must first upload the static guides and copied guide media, export only the WordPress-prefixed tables as an Actions artifact, verify the three public guide URLs, and only then remove WordPress files and WordPress tables.
