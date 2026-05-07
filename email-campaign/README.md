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
- interní cron endpoint pro automaticke spousteni
- SQLite databaze bez nutnosti spravovat MySQL

## Instalace na hosting

1. Nahraj obsah slozky `email-campaign` na hosting, nebo pouzij GitHub Actions workflow `Deploy Email Campaign`.
2. Otevri aplikaci v prohlizeci a vytvor prvni administracni heslo.
3. Po prihlaseni nastav SMTP pristup a otestuj konektivitu.
4. Over, ze hosting umi PHP 8.1+ a extension `pdo_sqlite`.
5. Nastav zapis do slozky `storage`.

## GitHub secrets pro deploy

Workflow `.github/workflows/email-campaign-deploy.yml` ceka tyto secrets:

- `HOSTING_FTP_SERVER`
- `HOSTING_FTP_USERNAME`
- `HOSTING_FTP_PASSWORD`
- `HOSTING_FTP_DIR`

Cron URL ma tvar:

```text
https://osobnizkusenosti.cz/email-campaign/?cron=TVUJ_CRON_TOKEN
```

Cron token se generuje automaticky pri prvnim nastaveni aplikace a neni bezna polozka v administraci.

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
Po zmene FTP webrootu staci znovu pushnout libovolnou zmenu v teto slozce a workflow provede novy upload.

Automaticky rezim zacina u zahrate schranky na 100 emailech denne, po uspesnych odesilacich dnech zvysuje limit priblizne o 20 % a respektuje rucni maximum kampane. Pokud aplikace za posledni dny vidi zvysenou SMTP chybovost, limit drzi nebo snizi. Aplikace zatim nemeri otevreni, spam stiznosti ani reputaci u Gmail Postmaster Tools, proto je porad dulezite sledovat realne odpovedi, bouncy a kvalitu seznamu.
