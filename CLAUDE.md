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

## Každou změnu musí hlídat test

Bez výjimky. Ale „napsat test" nestačí — dvakrát po sobě prošla celá sada zelená
přes rozbitou funkci, takže platí konkrétní pravidla, ne zásada:

1. **Test musí kód spustit, ne popsat.** Tvrzení typu „ve zdrojáku je tenhle
   řádek" chytí jen překlep. Certainty close se třikrát prodal za 99 % místo
   99,9 % a pokaždé ho „hlídal" test, který četl zdroják a potvrdil, že vypadá
   správně — on vypadal. Stejně tak `renderScrapedOpportunities` odkazoval na
   proměnnou, která neexistovala, a sada byla zelená.
   Síť podstrč (`globalThis.fetch`), DOM podstrč, a testuj **co funkce
   rozhodne**. Na zdroják se odkazuj jen tam, kde se propojení spustit nedá.

2. **Ke každé opravě bug přehraj jako bait control.** Vrať chybu, spusť testy a
   ověř, že test **spadne**. Pokud projde, nemáš oporu v testu — máš díru
   v testu a musíš opravit ten.

3. **Bait, který neselhal, je nález.** Už se to stalo několikrát: křížek u tagu
   mazal první štítek místo svého, kontrola per-fixture nálepek testovala tvar,
   který se do dat nikdy nedostane, a test počítal svou vlastní množinu místo
   té z kódu. Pokaždé to odhalil až bait, ne původní test.

4. **Před pushem celá sada**, ne jen dotčený soubor:
   `node --test trading/tests/*.test.mjs`. CI to pustí taky
   (`trading-tests.yml`), ale to je záchranná síť, ne náhrada.

5. **Starý test, který brání změně, se přepisuje, nemaže** — na nový tvar téhož
   záměru. Smazat ho smíš jen tehdy, když byla odstraněna sama funkce, kterou
   testoval, a v commitu to napiš.

## Rozsah práce

- Trading dashboard a boti: `trading/`. Deploy jde přes `trading-deploy.yml`.
- `email-campaign/` je **jiný projekt**. Nepleť ho do trading zadání.
- `.rpi-cmd*` patří do repozitáře *openclaw*, ne sem.

## Čtení jde z MySQL (od 12. 9. 2026)

Dashboard i boti čtou z databáze, ne z JSON souborů. Mirror zapisuje dál a JSON
soubory se publikují dál — jsou záložní zdroj i vstup migrace.

- **Vrátit zpět:** `trading-storage-migration.yml`, operation `deactivate`. Jeden krok,
  účinkuje okamžitě.
- **Ověřit:** `trading-read-path-check.yml` projde všechny pohledy, které načítá
  prohlížeč, a vypíše stav, čas a velikost každého. Žádný nesmí selhat ani přesáhnout
  ~5 s (dashboard dává requestům 10).
- **Změřit bez přepnutí:** `api.php?action=summary-build-probe&summary=…` postaví
  pohled tak, jak ho staví aktivní databáze, i když se čte z JSON. Takhle se našly
  chyby, které se jinak projeví až výpadkem.
- **Katalog je teď ~3× větší** (26 000 čerstvých trhů proti 8 000 v souboru). Limit
  8 000 existoval kvůli velikosti jednoho JSON souboru; databáze ho nepotřebuje.

Naměřeno při přepnutí: nejpomalejší pohled 3,0 s, exekuční shortlist 1,76 s, scoped
dotaz proti čtení celého katalogu 9,3× rychlejší.

## Měření produkce

Polymarket a `osobnizkusenosti.cz` jsou z kontejneru blokované egress proxy.
Všechno měření na produkci proto jde přes dispatchnuté read-only GitHub Actions
workflow (`trading-*-diagnosis.yml`), nikdy ne přímým `curl`em.

## Paralelní práce

Na téže větvi pracuje víc agentů (Codex i další sessions). Před commitem
`git fetch` a zkontroluj, že se cizí commity nepřepisují.
