# Pravidla pro tento repozitář

## Když se moje požadavky dostanou do konfliktu, doptej se

Pokud nový požadavek odporuje něčemu, co jsem si dřív vybral nebo schválil
(jiná hodnota limitu, jiné chování, opačné rozhodnutí), **nejdřív se zeptej a
teprve pak změnu udělej**. Neřeš to sám tím, že vybereš novější zadání a starší
tiše přepíšeš.

Výjimka je jen případ, kdy jsem konflikt vyřešil už ve svém zadání — tedy dal
preferenci i náhradní variantu ("nechceme strop; pokud je nutný, aspoň
zdvojnásob"). Tam se neptej, jen jasně napiš, kterou variantu jsi použil a proč.

Tohle platí pro celé prostředí Claude Code, ve všech projektech, ne jen tady.

## Rozsah práce

- Trading dashboard a boti: `trading/`. Deploy jde přes `trading-deploy.yml`.
- `email-campaign/` je **jiný projekt**. Nepleť ho do trading zadání.
- `.rpi-cmd*` patří do repozitáře *openclaw*, ne sem.

## Měření produkce

Polymarket a `osobnizkusenosti.cz` jsou z kontejneru blokované egress proxy.
Všechno měření na produkci proto jde přes dispatchnuté read-only GitHub Actions
workflow (`trading-*-diagnosis.yml`), nikdy ne přímým `curl`em.

## Paralelní práce

Na téže větvi pracuje víc agentů (Codex i další sessions). Před commitem
`git fetch` a zkontroluj, že se cizí commity nepřepisují.
