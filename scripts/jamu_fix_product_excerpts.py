from __future__ import annotations

import json
from pathlib import Path


TRANSLATIONS: dict[str, dict[int, str]] = {
    "en": {
        17: "Tanamu Tanami oil is focused on skin care. It helps improve skin affected by various skin concerns and conditions such as scars, acne and blackheads, facial pigmentation, eczema, cellulite and stretch marks. It has a positive effect on dry to flaky skin and wounds. It soothes sun-irritated skin and supports recovery from sunburn.",
        18: "Kutus Kutus Minyak Balur massage and therapeutic oil is a Balinese herbal oil made from 69 medicinal plants and coconut oil. It has a positive effect on health, mood and overall energy. I recommend using it for massages, self-massage, faster pain relief and as overall support during recovery.",
        19: "This soap is based on tamanu oil and is suitable for the face and the whole body. Tanamu Tanami soap helps care for problem skin, especially acne, dry and flaky skin, cracked skin, blisters, burns, skin ulcers, eczema and itching.",
        20: "Kalila Kalila herbal soap is made from 100% natural ingredients. It contains the same ingredients and herbs as Minyak Balur herbal oil. The soap is based on coconut oil, olive oil and 69 herbs.",
        3614: "A blend of essential oils from sacred flowers in incense sticks naturally purifies the air, harmonises energy and supports relaxation of the body and mind. They are 100% natural, without synthetic substances. Suitable for meditation, yoga and massage.",
        3623: "A blend of Balinese essential oils in incense sticks naturally purifies the air, harmonises energy and supports a meditative mood. They are 100% natural, without synthetic additives. Ideal for meditation, yoga or massage.",
        3664: "Add a touch of exotic Bali to your kitchen with a wooden bowl handmade on the sunny island of Bali. Each bowl is carefully carved from quality teak wood, giving it a unique and authentic appearance.",
        3678: "Bring a piece of Balinese beauty into your bathroom with our teak soap dish. The soap dishes are handmade with love and care on the island of Bali, where artisans use traditional woodworking techniques passed down from generation to generation.",
        3685: "This elegant cup can be used not only in the kitchen for serving drinks, sauces and dips, but also on a festive table as a small bowl for snacks such as nuts or dried fruit.",
        3686: "Pamper your skin according to Ayurveda – a Balinese body cream with aloe vera, coconut oil and cocoa butter for hydration and elasticity. Enriched with Triphala oil, it gives the skin antioxidants and healthy vitality, with a gentle earthy-spicy scent.",
        3688: "A cream with frangipani (plumeria) flower essential oil that softens, regenerates and deeply hydrates the skin. The delicate exotic scent of frangipani evokes calm, harmony and deep relaxation, turning everyday care into a soothing ritual.",
        3689: "Sacred Scent body cream is made by a small local producer, Nadis Herbal, which creates products according to a traditional holistic recipe. Only natural ingredients are used, most of them from their own garden. It combines traditional holistic cosmetic recipes with aromatherapy. This product blends sacred flower essences such as champaca, vetiver and patchouli. Ingredients: aloe vera, coconut oil, cocoa butter, beeswax, seaweed (Euchema spinosum), distilled water, champaca oil, vetiver oil, patchouli oil.",
        4293: "A natural solid Bali Flowers perfume with a captivating scent of Balinese flowers such as jasmine, champaca and frangipani (plumeria). Package content: 15 g.",
        4398: "Lemongrass body butter with lemongrass essential oil refreshes you and gives you energy. It refreshes the skin and acts as a natural deodorant.",
        4405: "Brighten and soften your skin with Bali Moon cream, which combines the power of seaweed – a natural source of hydrating “marine collagen” – with delicate roses. The cream leaves the skin soft, supple and radiant.",
        4528: "A traditional Indonesian drink made with turmeric, ginger, Javanese ginger kencur and black pepper. Made in Bali with respect for jamu tradition and natural ingredients. Ideal for moments when you want to enjoy a warm, warming drink and a short self-care ritual.",
        4539: "Why you will love Balance: pleasantly warming and spicy taste, a traditional blend made in Bali, contains turmeric, ginger and kencur, gently sweetened with coconut sugar, easy and quick to prepare. Preparation: stir one teaspoon of the blend into approximately 200 ml of warm water. You can add sweetener (honey or coconut sugar), lemon or lime to taste. A 50 g pack makes about 12 drinks. Ingredients: ginger, turmeric, kencur – Javanese ginger, black pepper. Weight: 50 g. Country of origin: Indonesia. Made in Bali. Because therapeutic effects cannot be stated for foods, take a look at the individual ingredients to learn more about their traditional use and properties.",
        4542: "A traditional Indonesian drink made with turmeric, ginger, red ginger and black pepper. Suitable for moments when your digestion asks for lightness and your body wants to return to its natural balance.",
        4544: "A traditional Indonesian drink made with turmeric, ginger, red ginger and black pepper. Suitable for moments when your digestion asks for lightness and your body wants to return to its natural balance.",
    },
    "de": {
        17: "Tanamu Tanami Öl ist auf die Hautpflege ausgerichtet. Es unterstützt die Pflege von Haut mit verschiedenen Hautproblemen und Beschwerden wie Narben, Akne und Mitessern, Pigmentflecken im Gesicht, Ekzemen, Cellulite und Dehnungsstreifen. Es wirkt positiv auf trockene bis schuppige Haut und Wunden. Es beruhigt sonnenreizte Haut und unterstützt die Regeneration bei Sonnenbrand.",
        18: "Kutus Kutus Minyak Balur Massage- und Therapieöl ist ein balinesisches Kräuteröl aus 69 Heilpflanzen und Kokosöl. Es wirkt positiv auf Gesundheit, Psyche und die allgemeine Energie. Ich empfehle es für Massagen, Selbstmassagen, zur schnelleren Linderung von Schmerzen und als allgemeine Unterstützung während der Regeneration.",
        19: "Diese Seife basiert auf Tamanuöl und eignet sich für Gesicht und Körper. Die Tanamu Tanami Seife hilft bei der Pflege problematischer Haut, besonders bei Akne, trockener und schuppiger Haut, rissiger Haut, Blasen, Verbrennungen, Hautgeschwüren, Ekzemen und Juckreiz.",
        20: "Die Kräuterseife Kalila Kalila wird aus 100% natürlichen Inhaltsstoffen hergestellt. Sie enthält die gleichen Zutaten und Kräuter wie das Kräuteröl Minyak Balur. Die Seife basiert auf Kokosöl, Olivenöl und 69 Kräutern.",
        3614: "Eine Mischung ätherischer Öle heiliger Blüten in Räucherstäbchen reinigt auf natürliche Weise die Luft, harmonisiert die Energie und unterstützt die Entspannung von Körper und Geist. Sie sind 100% natürlich, ohne synthetische Stoffe. Geeignet für Meditation, Yoga und Massagen.",
        3623: "Eine Mischung ätherischer Öle aus Bali in Räucherstäbchen reinigt auf natürliche Weise die Luft, harmonisiert die Energie und unterstützt eine meditative Stimmung. Sie sind 100% natürlich, ohne synthetische Zusätze. Ideal für Meditation, Yoga oder Massagen.",
        3664: "Bringen Sie ein Stück exotisches Bali in Ihre Küche mit einer Holzschale, die auf der sonnigen Insel Bali von Hand gefertigt wurde. Jede Schale wird sorgfältig aus hochwertigem Teakholz geschnitzt und erhält so ein einzigartiges, authentisches Aussehen.",
        3678: "Bringen Sie ein Stück balinesische Schönheit in Ihr Badezimmer mit unserer Seifenschale aus Teakholz. Die Seifenschalen werden auf Bali mit Liebe und Sorgfalt von Hand gefertigt, wo Handwerker traditionelle Holzbearbeitungstechniken verwenden, die von Generation zu Generation weitergegeben werden.",
        3685: "Diese elegante Tasse kann nicht nur in der Küche zum Servieren von Getränken, Saucen und Dips verwendet werden, sondern auch auf der Festtafel als kleine Schale für Snacks wie Nüsse oder Trockenfrüchte.",
        3686: "Verwöhnen Sie Ihre Haut nach Ayurveda – eine balinesische Körpercreme mit Aloe vera, Kokosöl und Kakaobutter für Feuchtigkeit und Geschmeidigkeit. Angereichert mit Triphala-Öl versorgt sie die Haut mit Antioxidantien und gesunder Vitalität, mit einem sanften erdig-würzigen Duft.",
        3688: "Eine Creme mit ätherischem Öl aus Frangipani-Blüten (Plumeria), die die Haut weich macht, regeneriert und intensiv mit Feuchtigkeit versorgt. Der zarte exotische Duft von Frangipani schenkt Ruhe, Harmonie und tiefe Entspannung und verwandelt die tägliche Pflege in ein beruhigendes Ritual.",
        3689: "Sacred Scent Körpercreme wird von dem kleinen lokalen Hersteller Nadis Herbal hergestellt, der seine Produkte nach einer traditionellen ganzheitlichen Rezeptur fertigt. Für die Herstellung werden ausschließlich natürliche Zutaten verwendet, die meisten davon stammen aus dem eigenen Garten. Sie verbindet traditionelle holistische Kosmetikrezepte mit Aromatherapie. Dieses Produkt kombiniert Essenzen heiliger Blüten wie Champaka, Vetiver und Patchouli. Inhaltsstoffe: Aloe vera, Kokosöl, Kakaobutter, Bienenwachs, Meeresalge (Euchema spinosum), destilliertes Wasser, Champakaöl, Vetiveröl, Patchouliöl.",
        4293: "Ein natürliches festes Parfum Bali Flowers mit dem betörenden Duft balinesischer Blüten wie Jasmin, Champaka und Frangipani (Plumeria). Inhalt: 15 g.",
        4398: "Lemongrass Körperbutter mit ätherischem Zitronengrasöl belebt und schenkt Energie. Sie erfrischt die Haut und wirkt wie ein natürliches Deodorant.",
        4405: "Bringen Sie Ihre Haut zum Strahlen und machen Sie sie geschmeidig mit der Bali Moon Creme, die die Kraft von Meeresalgen – einer natürlichen Quelle hydratisierenden „Meereskollagens“ – mit zarten Rosen verbindet. Die Creme hinterlässt die Haut weich, geschmeidig und strahlend.",
        4528: "Ein traditionelles indonesisches Getränk aus Kurkuma, Ingwer, javanischem Ingwer Kencur und schwarzem Pfeffer. Hergestellt auf Bali mit Respekt vor der Jamu-Tradition und natürlichen Zutaten. Ideal für Momente, in denen Sie sich ein warmes, wärmendes Getränk und ein kurzes Selbstpflegeritual gönnen möchten.",
        4539: "Warum Sie Balance lieben werden: angenehm wärmender und würziger Geschmack, traditionelle Mischung aus Bali, enthält Kurkuma, Ingwer und Kencur, sanft mit Kokoszucker gesüßt, einfach und schnell zuzubereiten. Zubereitung: Einen Teelöffel der Mischung in etwa 200 ml warmem Wasser verrühren. Nach Geschmack können Sie Süßungsmittel (Honig oder Kokoszucker), Zitrone oder Limette hinzufügen. Eine 50-g-Packung reicht für etwa 12 Getränke. Zutaten: Ingwer, Kurkuma, Kencur – javanischer Ingwer, schwarzer Pfeffer. Gewicht: 50 g. Herkunftsland: Indonesien. Hergestellt auf Bali. Da bei Lebensmitteln keine therapeutischen Wirkungen angegeben werden dürfen, sehen Sie sich die einzelnen Zutaten an und erfahren Sie mehr über ihre traditionelle Verwendung und Eigenschaften.",
        4542: "Ein traditionelles indonesisches Getränk aus Kurkuma, Ingwer, rotem Ingwer und schwarzem Pfeffer. Geeignet für Momente, in denen Ihre Verdauung Leichtigkeit sucht und der Körper in sein natürliches Gleichgewicht zurückfinden möchte.",
        4544: "Ein traditionelles indonesisches Getränk aus Kurkuma, Ingwer, rotem Ingwer und schwarzem Pfeffer. Geeignet für Momente, in denen Ihre Verdauung Leichtigkeit sucht und der Körper in sein natürliches Gleichgewicht zurückfinden möchte.",
    },
    "pl": {
        17: "Olejek Tanamu Tanami jest przeznaczony do pielęgnacji skóry. Pomaga pielęgnować skórę przy różnych problemach i dolegliwościach skórnych, takich jak blizny, trądzik i zaskórniki, przebarwienia na twarzy, egzema, cellulit i rozstępy. Dobrze działa na skórę suchą i łuszczącą się oraz na drobne rany. Koi skórę podrażnioną słońcem i wspiera regenerację po oparzeniach słonecznych.",
        18: "Olejek do masażu i terapii Kutus Kutus Minyak Balur to balijski olejek ziołowy z 69 roślin leczniczych i oleju kokosowego. Korzystnie wpływa na zdrowie, psychikę i ogólną energię. Polecam go do masażu, automasażu, szybszego łagodzenia bólu oraz jako ogólne wsparcie podczas regeneracji.",
        19: "Mydło na bazie oleju tamanu nadaje się do twarzy i całego ciała. Mydło Tanamu Tanami pomaga pielęgnować skórę problematyczną, szczególnie przy trądziku, suchej i łuszczącej się skórze, pękającej skórze, pęcherzach, oparzeniach, owrzodzeniach skóry, egzemie i swędzeniu.",
        20: "Ziołowe mydło Kalila Kalila jest wykonane w 100% z naturalnych składników. Zawiera te same składniki i zioła co ziołowy olejek Minyak Balur. Mydło powstaje na bazie oleju kokosowego, oliwy z oliwek i 69 ziół.",
        3614: "Mieszanka olejków eterycznych ze świętych kwiatów w kadzidełkach naturalnie oczyszcza powietrze, harmonizuje energię i wspiera relaks ciała oraz umysłu. Są w 100% naturalne, bez syntetycznych substancji. Odpowiednie do medytacji, jogi i masażu.",
        3623: "Mieszanka balijskich olejków eterycznych w kadzidełkach naturalnie oczyszcza powietrze, harmonizuje energię i wspiera medytacyjny nastrój. Są w 100% naturalne, bez syntetycznych dodatków. Idealne do medytacji, jogi lub masażu.",
        3664: "Dodaj do swojej kuchni odrobinę egzotycznego Bali dzięki drewnianej miseczce wykonanej ręcznie na słonecznej wyspie Bali. Każda miseczka jest starannie rzeźbiona z wysokiej jakości drewna tekowego, dzięki czemu ma wyjątkowy i autentyczny wygląd.",
        3678: "Wnieś kawałek balijskiego piękna do swojej łazienki dzięki naszej mydelniczce z drewna tekowego. Mydelniczki są wykonywane ręcznie z miłością i starannością na Bali, gdzie rzemieślnicy stosują tradycyjne techniki obróbki drewna przekazywane z pokolenia na pokolenie.",
        3685: "Ten elegancki kubeczek można wykorzystać nie tylko w kuchni do podawania napojów, sosów i dipów, ale także na świątecznym stole jako małą miseczkę na przekąski, na przykład orzechy lub suszone owoce.",
        3686: "Rozpieszczaj skórę zgodnie z Ajurwedą – balijski krem do ciała z aloesem, olejem kokosowym i masłem kakaowym dla nawilżenia i elastyczności. Wzbogacony olejem Triphala dostarcza skórze antyoksydantów i zdrowej witalności, z delikatnym ziemisto-korzennym zapachem.",
        3688: "Krem z olejkiem eterycznym z kwiatów frangipani (plumerii), który zmiękcza, regeneruje i intensywnie nawilża skórę. Delikatny egzotyczny zapach frangipani daje poczucie spokoju, harmonii i głębokiego relaksu, zamieniając codzienną pielęgnację w kojący rytuał.",
        3689: "Krem do ciała Sacred Scent jest wytwarzany przez małego lokalnego producenta Nadis Herbal, który tworzy produkty według tradycyjnej holistycznej receptury. Do produkcji używa się wyłącznie naturalnych składników, większość z nich pochodzi z własnego ogrodu. Łączy tradycyjne receptury kosmetyki holistycznej z aromaterapią. Produkt zawiera połączenie esencji świętych kwiatów, takich jak champaka, wetiwer i paczula. Skład: aloes, olej kokosowy, masło kakaowe, wosk pszczeli, algi morskie (Euchema spinosum), woda destylowana, olejek champaka, olejek wetiwerowy, olejek paczulowy.",
        4293: "Naturalne perfumy w sztyfcie Bali Flowers o urzekającym zapachu balijskich kwiatów, takich jak jaśmin, champaka i frangipani (plumeria). Zawartość opakowania: 15 g.",
        4398: "Masło do ciała Lemongrass z olejkiem eterycznym z trawy cytrynowej pobudza i dodaje energii. Odświeża skórę i działa jak naturalny dezodorant.",
        4405: "Rozświetl i zmiękcz skórę kremem Bali Moon, który łączy moc alg morskich – naturalnego źródła nawilżającego „morskiego kolagenu” – z delikatnymi różami. Krem pozostawia skórę miękką, elastyczną i promienną.",
        4528: "Tradycyjny indonezyjski napój z kurkumy, imbiru, jawajskiego imbiru kencur i czarnego pieprzu. Wyprodukowany na Bali z szacunkiem dla tradycji jamu i naturalnych składników. Idealny na chwile, gdy chcesz pozwolić sobie na ciepły, rozgrzewający napój i krótki rytuał troski o siebie.",
        4539: "Dlaczego pokochasz Balance: przyjemnie rozgrzewający i korzenny smak, tradycyjna mieszanka produkowana na Bali, zawiera kurkumę, imbir i kencur, delikatnie słodzona cukrem kokosowym, łatwa i szybka w przygotowaniu. Przygotowanie: jedną łyżeczkę mieszanki wymieszaj w około 200 ml ciepłej wody. Do smaku możesz dodać słodzik (miód lub cukier kokosowy), cytrynę albo limonkę. Opakowanie 50 g wystarcza na około 12 napojów. Skład: imbir, kurkuma, kencur – imbir jawajski, czarny pieprz. Masa: 50 g. Kraj pochodzenia: Indonezja. Wyprodukowano na Bali. Ponieważ przy żywności nie można podawać działania leczniczego, zapoznaj się z poszczególnymi składnikami i dowiedz się więcej o ich tradycyjnym zastosowaniu oraz właściwościach.",
        4542: "Tradycyjny indonezyjski napój z kurkumy, imbiru, czerwonego imbiru i czarnego pieprzu. Odpowiedni na chwile, gdy trawienie potrzebuje lekkości, a ciało chce wrócić do naturalnej równowagi.",
        4544: "Tradycyjny indonezyjski napój z kurkumy, imbiru, czerwonego imbiru i czarnego pieprzu. Odpowiedni na chwile, gdy trawienie potrzebuje lekkości, a ciało chce wrócić do naturalnej równowagi.",
    },
}


def main() -> int:
    path = Path("jamu-content/translations-draft.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("translations", [])
    expected = {(language, object_id) for language, by_id in TRANSLATIONS.items() for object_id in by_id}
    updated: set[tuple[str, int]] = set()

    for row in rows:
        if row.get("object_type") != "post" or row.get("object_subtype") != "product":
            continue
        language = str(row.get("language", ""))
        object_id = int(row.get("object_id", 0))
        text = TRANSLATIONS.get(language, {}).get(object_id)
        if text is None:
            continue
        row["excerpt"] = text
        updated.add((language, object_id))

    missing = sorted(expected - updated)
    if missing:
        raise SystemExit(f"Missing product excerpt translation rows: {missing}")

    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Updated {len(updated)} product excerpt translations in {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
