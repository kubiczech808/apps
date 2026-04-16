"""POC: Stáhne spotřebu plynu Vaillant ecoTEC z myVAILLANT cloudu za zvolené
období, sečte kWh a vynásobí jednotkovou cenou.

Spuštění:
    python fetch_gas.py                     # defaultně 1.9.2025 → dnes
    python fetch_gas.py --from 2025-10-01   # jiný start
    python fetch_gas.py --price 2.15        # override ceny
    python fetch_gas.py --debug             # vypíše surové bucketů

Credentials a defaultní cena se berou z ../.env (viz .env.example).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

# myPyllant je async. Tyto importy musí fungovat po `pip install myPyllant`.
from myPyllant.api import MyPyllantAPI
from myPyllant.enums import DeviceDataBucketResolution


ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


@dataclass
class MonthSummary:
    year: int
    month: int
    kwh: float

    @property
    def label(self) -> str:
        return f"{self.year:04d}-{self.month:02d}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Vaillant gas consumption POC")
    parser.add_argument(
        "--from",
        dest="from_date",
        default="2025-09-01",
        help="Start data (YYYY-MM-DD), default 2025-09-01",
    )
    parser.add_argument(
        "--to",
        dest="to_date",
        default=None,
        help="Konec (YYYY-MM-DD), default dnes",
    )
    parser.add_argument(
        "--price",
        type=float,
        default=None,
        help="CZK/kWh, default z .env (GAS_PRICE_CZK_PER_KWH)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Vypsat surové bucketů a ladicí informace",
    )
    return parser.parse_args()


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        sys.exit(
            f"Chybí proměnná prostředí {name}. "
            f"Zkopíruj .env.example na .env a vyplň ji."
        )
    return value


def to_utc_midnight(date_str: str) -> datetime:
    d = datetime.strptime(date_str, "%Y-%m-%d")
    return d.replace(tzinfo=timezone.utc)


def is_gas_data(data) -> bool:
    """Vrátí True, pokud DeviceData reprezentuje plynovou spotřebu.

    myPyllant nemá pevně definované hodnoty energy_type. Typicky vrací
    řetězce jako 'CONSUMED_ELECTRICAL_ENERGY', 'HEATING_GAS_CONSUMPTION',
    'DOMESTIC_HOT_WATER_GAS_CONSUMPTION' apod. Zachytíme vše, co obsahuje 'GAS'
    (u ecoTEC je veškerá energie vstupující do kotle plyn).
    """
    energy_type = (getattr(data, "energy_type", "") or "").upper()
    return "GAS" in energy_type


def aggregate_monthly(buckets) -> list[MonthSummary]:
    sums: dict[tuple[int, int], float] = defaultdict(float)
    for bucket in buckets:
        if bucket.value is None:
            continue
        key = (bucket.start_date.year, bucket.start_date.month)
        sums[key] += bucket.value
    return [
        MonthSummary(year=y, month=m, kwh=kwh)
        for (y, m), kwh in sorted(sums.items())
    ]


def print_report(
    start: datetime,
    end: datetime,
    total_kwh: float,
    price: float,
    monthly: list[MonthSummary],
) -> None:
    days = (end - start).days or 1
    total_czk = total_kwh * price

    print()
    print("=" * 60)
    print("  Vaillant ecoTEC: spotřeba plynu")
    print("=" * 60)
    print(f"  Období:   {start.date()} → {end.date()}  ({days} dní)")
    print(f"  Cena:     {price:.2f} CZK/kWh")
    print()
    print(f"  Celkem:   {total_kwh:>10.1f} kWh   →  {total_czk:>9.0f} Kč")
    print(
        f"  Průměr:   {total_kwh / days:>10.1f} kWh/den "
        f"→  {total_czk / days:>9.0f} Kč/den"
    )
    print()
    if monthly:
        print("  Po měsících:")
        for m in monthly:
            czk = m.kwh * price
            print(f"    {m.label}   {m.kwh:>9.1f} kWh   {czk:>8.0f} Kč")
    print("=" * 60)
    print()


async def run() -> int:
    args = parse_args()

    user = require_env("MYVAILLANT_USER")
    password = require_env("MYVAILLANT_PASSWORD")
    country = os.getenv("MYVAILLANT_COUNTRY", "czechrepublic")
    brand = os.getenv("MYVAILLANT_BRAND", "vaillant")

    price = args.price if args.price is not None else float(
        os.getenv("GAS_PRICE_CZK_PER_KWH", "1.90")
    )

    start = to_utc_midnight(args.from_date)
    end = (
        to_utc_midnight(args.to_date)
        if args.to_date
        else datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
    )
    if end <= start:
        sys.exit("Konec musí být po začátku.")

    print(f"Přihlašuji se do myVAILLANT ({brand}/{country}) jako {user}...")

    async with MyPyllantAPI(user, password, brand, country) as api:
        all_buckets: list = []
        found_gas_stream = False
        heat_generator_found = False

        async for system in api.get_systems():
            if args.debug:
                print(f"[DEBUG] Systém: id={system.id} devices={len(system.devices)}")

            for device in system.devices:
                device_type = getattr(device, "type", None) or getattr(
                    device, "device_type", None
                )
                if args.debug:
                    print(
                        f"[DEBUG]   Device: type={device_type} "
                        f"name={getattr(device, 'name', '?')} "
                        f"id={getattr(device, 'device_uuid', '?')}"
                    )

                # Bereme všechny heat generatory – primary i případné další.
                if device_type not in (
                    "primary_heat_generator",
                    "secondary_heat_generator",
                ):
                    continue
                heat_generator_found = True

                async for data in api.get_data_by_device(
                    device,
                    data_resolution=DeviceDataBucketResolution.DAY,
                    data_from=start,
                    data_to=end,
                ):
                    if args.debug:
                        print(
                            f"[DEBUG]     DeviceData energy_type={data.energy_type} "
                            f"value_type={getattr(data, 'value_type', '?')} "
                            f"operation_mode={data.operation_mode} "
                            f"buckets={len(data.data)} "
                            f"total_consumption={data.total_consumption}"
                        )
                    if not is_gas_data(data):
                        continue
                    found_gas_stream = True
                    all_buckets.extend(data.data)

        if not heat_generator_found:
            print("CHYBA: V účtu se nenašel žádný heat generator (kotel).")
            return 2
        if not found_gas_stream:
            print(
                "CHYBA: Kotel se našel, ale API nevrátilo žádný stream s "
                "energy_type obsahujícím 'GAS'. Spusť znovu s --debug pro diagnostiku."
            )
            return 3

    total_kwh = sum(b.value for b in all_buckets if b.value is not None)
    monthly = aggregate_monthly(all_buckets)
    print_report(start, end, total_kwh, price, monthly)
    return 0


def main() -> None:
    try:
        rc = asyncio.run(run())
    except KeyboardInterrupt:
        rc = 130
    sys.exit(rc)


if __name__ == "__main__":
    main()
