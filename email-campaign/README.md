# Email rozesilac

Jednoducha PHP aplikace pro postupne odesilani pripraveneho emailu na importovany seznam prijemcu.

## Funkce

- prihlaseni jednim administracnim heslem
- CSV import prijemcu
- WYSIWYG editor obsahu emailu
- promenne `{{name}}` a `{{email}}`
- testovaci odeslani na vybranou adresu
- davkove odesilani s dennim limitem, typicky 100 emailu denne
- cron endpoint pro automaticke spousteni
- SQLite databaze bez nutnosti spravovat MySQL

## Instalace na hosting

1. Nahraj obsah slozky `email-campaign` na hosting, nebo pouzij GitHub Actions workflow `Deploy Email Campaign`.
2. Pri rucnim nahrani zkopiruj `config.example.php` jako `config.php`.
3. Vypln SMTP pristup, odesilatele, `cron_token` a `app_password_hash`.
4. Over, ze hosting umi PHP 8.1+ a extension `pdo_sqlite`.
5. Nastav zapis do slozky `storage`.

Hash hesla vygeneruj lokalne:

```bash
php -r "echo password_hash('moje-heslo', PASSWORD_DEFAULT), PHP_EOL;"
```

## GitHub secrets pro deploy

Workflow `.github/workflows/email-campaign-deploy.yml` ceka tyto secrets:

- `HOSTING_FTP_SERVER`
- `HOSTING_FTP_USERNAME`
- `HOSTING_FTP_PASSWORD`
- `HOSTING_FTP_DIR`
- `EMAIL_APP_PASSWORD_HASH`
- `EMAIL_CRON_TOKEN`
- `EMAIL_FROM_EMAIL`
- `EMAIL_FROM_NAME`
- `EMAIL_SMTP_HOST`
- `EMAIL_SMTP_PORT`
- `EMAIL_SMTP_USERNAME`
- `EMAIL_SMTP_PASSWORD`
- `EMAIL_SMTP_ENCRYPTION`

Cron URL ma tvar:

```text
https://osobnizkusenosti.cz/email-campaign/?cron=TVUJ_CRON_TOKEN
```

## CSV import

Preferovany format:

```csv
email,name
jana@example.cz,Jana
petr@example.cz,Petr
```

Bez hlavicky aplikace bere prvni sloupec jako email a druhy jako jmeno.

## Dorucitelnost

Aplikace omezuje tempo podle denniho limitu kampane. Pro realnou dorucitelnost je jeste potreba mit na domene spravne nastavene SPF, DKIM a DMARC zaznamy a posilat pres SMTP sluzbu s dobrou reputaci.
