# POC: Vaillant ecoTEC – spotřeba plynu přes myVAILLANT API

Jednoduchý skript, který ověřuje, že jsme přes internet schopni z myVAILLANT
cloudu stáhnout spotřebu plynu kotle Vaillant ecoTEC za zvolené období,
sečíst ji a vynásobit cenou plynu.

## Co skript dělá

1. Přihlásí se do myVAILLANT (Keycloak/OIDC) uživatelskými údaji z `.env`.
2. Najde všechny heat generatory (kotle) v účtu.
3. Stáhne denní historická data spotřeby a vyfiltruje ta s `energy_type`
   obsahujícím `GAS`.
4. Sečte kWh za zadané období a vynásobí `GAS_PRICE_CZK_PER_KWH`.
5. Vytiskne souhrn: celkem, průměr denně, rozpad po měsících.

Žádná databáze, žádné uložení, žádné UI – jen CLI test.

## Setup

```bash
# v kořenu repa
python3 -m venv .venv
source .venv/bin/activate
pip install -r poc/requirements.txt

# zkopíruj šablonu a vyplň reálné údaje
cp .env.example .env
#   MYVAILLANT_USER=...
#   MYVAILLANT_PASSWORD=...
#   MYVAILLANT_COUNTRY=czechrepublic
#   MYVAILLANT_BRAND=vaillant
#   GAS_PRICE_CZK_PER_KWH=1.90
```

## Spuštění

```bash
# defaultně 2025-09-01 → dnes
python poc/fetch_gas.py

# jiné období
python poc/fetch_gas.py --from 2025-10-01 --to 2026-04-16

# override ceny
python poc/fetch_gas.py --price 2.15

# diagnostika (vypíše nalezená zařízení a streamy dat)
python poc/fetch_gas.py --debug
```

## Očekávaný výstup

```
============================================================
  Vaillant ecoTEC: spotřeba plynu
============================================================
  Období:   2025-09-01 → 2026-04-16  (228 dní)
  Cena:     1.90 CZK/kWh

  Celkem:      12345.6 kWh   →     23456 Kč
  Průměr:         54.1 kWh/den →       103 Kč/den

  Po měsících:
    2025-09       523.1 kWh      993 Kč
    2025-10      1412.7 kWh     2684 Kč
    ...
============================================================
```

## Poznámky / troubleshooting

- Pokud skončí chybou přihlášení, ověř `MYVAILLANT_COUNTRY=czechrepublic`
  (bez podtržítka, jedno slovo) a brand `vaillant`.
- Pokud API nevrátí žádný `GAS` stream, spusť s `--debug` a koukni se
  na `energy_type` hodnoty – kotle občas hlásí pod jiným názvem.
- Pokud je rozsah historie kratší, než očekáváš, zkus postupně posouvat
  `--from` dopředu – myVAILLANT typicky drží 1–2 roky zpět.
