# Email rozesilac

Jednoducha PHP aplikace pro postupne odesilani pripraveneho emailu na importovany seznam prijemcu.

## Funkce

- prvni nastaveni administracniho hesla v aplikaci
- CSV import prijemcu
- WYSIWYG editor obsahu emailu
- promenne `{{name}}` a `{{email}}`
- nastaveni SMTP uctu a test konektivity primo v administraci
- testovaci odeslani na vybranou adresu
- davkove odesilani s dennim limitem, typicky 100 emailu denne
- limit na jedno spusteni, aby slo rozesilku rozlozit do dne
- automaticky denni limit podle odesilacich dnu a SMTP chyb
- seznam kontaktu se stavem osloveni, otevreni a prokliku
- kontakty s nazvem subjektu a webem, email je unikatni identifikator
- historie importu vcetne poctu vlozenych, aktualizovanych a preskocenych radku
- interní cron endpoint pro automaticke spousteni
- SQLite databaze bez nutnosti spravovat MySQL

## Instalace na hosting

1. Nahraj obsah slozky `email-campaign` na hosting, nebo pouzij GitHub Actions workflow `Deploy Email Campaign`.
2. Otevri aplikaci v prohlizeci a vytvor prvni administracni heslo.
3. Po prihlaseni nastav SMTP pristup a otestuj konektivitu.
4. Over, ze hosting umi PHP 7.4+ a bud `pdo_sqlite`, nebo `pdo_mysql`.
5. Nastav zapis do slozky `storage`.

## GitHub secrets pro deploy

Workflow `.github/workflows/email-campaign-deploy.yml` ceka tyto secrets:

- `HOSTING_FTP_SERVER`
- `HOSTING_FTP_USERNAME`
- `HOSTING_FTP_PASSWORD`
- `HOSTING_FTP_DIR`

Volitelne MySQL/MariaDB secrets:

- `APP_DATABASE_DRIVER` = `mysql`
- `APP_DATABASE_HOST`
- `APP_DATABASE_PORT`
- `APP_DATABASE_NAME`
- `APP_DATABASE_USERNAME`
- `APP_DATABASE_PASSWORD`

Pokud MySQL secrets nejsou vyplnene, aplikace bezi nad SQLite souborem `storage/app.sqlite`. SQLite je porad SQL databaze, ale pro dlouhodobejsi provoz a zalohy je lepsi MySQL/MariaDB od hostingu.

Cron URL ma tvar:

```text
https://osobnizkusenosti.cz/email-campaign/?cron=TVUJ_CRON_TOKEN
```

Cron token se generuje automaticky pri prvnim nastaveni aplikace a neni bezna polozka v administraci.

## CSV import

Preferovany format:

```csv
email,subject_name,website
jana@example.cz,Masazni studio Jana,https://example.cz
petr@example.cz,Petr masaze,example.com
```

Bez hlavicky aplikace bere prvni sloupec jako email. Pokud importujes email, ktery uz v danem seznamu existuje, kontakt se aktualizuje novymi neprazdnymi udaji. Prazdny subjekt nebo web v CSV neprepisuje existujici hodnotu.

## Dorucitelnost

Aplikace omezuje tempo podle denniho limitu kampane. Pro realnou dorucitelnost je jeste potreba mit na domene spravne nastavene SPF, DKIM a DMARC zaznamy a posilat pres SMTP sluzbu s dobrou reputaci.
Po zmene FTP webrootu staci znovu pushnout libovolnou zmenu v teto slozce a workflow provede novy upload.

Automaticky rezim zacina u zahrate schranky na 100 emailech denne, po uspesnych odesilacich dnech zvysuje limit priblizne o 20 % a respektuje rucni maximum kampane. Pokud aplikace za posledni dny vidi zvysenou SMTP chybovost, limit drzi nebo snizi. Aplikace zatim nemeri otevreni, spam stiznosti ani reputaci u Gmail Postmaster Tools, proto je porad dulezite sledovat realne odpovedi, bouncy a kvalitu seznamu.

## Tracking

Stav `Osloven` znamena, ze nas SMTP server email prijal. Otevreni se meri pres 1x1 pixel a kliky pres prepsane odkazy, ktere se po zaznamu presmeruji na cilovou URL. Tyto metriky jsou orientacni, protoze nektere emailove aplikace obrazky blokuji nebo prednacitaji. Realne doruceni do inboxu vyzaduje bounce/webhook napojeni a odpovedi vyzaduji IMAP napojeni schranky.
