# Meerwaardebelasting – Android-app

Android-app met exact dezelfde functies als de browserversie: de app toont `browser/index.html` (gebouwd met
`build.py`) in een WebView. Er is geen tweede rekenkern; elke wijziging in `browser/` komt bij de volgende
build vanzelf mee.

> **Disclaimer:** rekenhulp, geen fiscaal advies. Controleer met de FOD Financiën of een adviseur.

## Wat de app doet

| Functie | Hoe in de app |
|---|---|
| Gegevens bewaren | localStorage van de WebView, in de privé-opslag van de app op dit toestel. Geen Android-back-up naar Google (`allowBackup=false`): gebruik de back-up of synchronisatie van de tool zelf. Bij het verwijderen van de app gaan de gegevens verloren. |
| Bolero/Saxo-export en back-up inlezen | Android-bestandskiezer |
| Back-up, CSV en PDF-rapport bewaren | Android vraagt waar het bestand moet komen (via `MeerwaardeAndroid.saveFile` in `app.js`) |
| Synchroniseren tussen toestellen | Zoals in de browser (zelfde sync-server; die laat elk adres toe via CORS) |
| QR-code scannen | Camera in de app; Android vraagt de eerste keer toestemming |
| Werkt zonder internet | Ja, de pagina zit in de APK (enkel synchroniseren heeft internet nodig) |

De pagina draait op `https://appassets.androidplatform.net/` (een adres dat de app zelf beantwoordt, nooit het
netwerk), zodat Web Crypto en de camera werken zoals op een gewone https-pagina.

Je gegevens van de browserversie of de claude.ai-pagina overzetten: koppel beide met *Synchroniseren*, of maak daar
een back-up en herstel die in de app.

## Downloaden

GitHub bouwt de APK automatisch (workflow `.github/workflows/android.yml`):

- **Laatste versie van `main`:** release *Android-app* (tag `android-latest`) op
  https://github.com/Glorfunk850/Meerwaardebelasting/releases/tag/android-latest → `meerwaardebelasting.apk`.
  Open die link op je telefoon, download de APK en open ze (sta *installeren uit onbekende bronnen* toe).
- **Elke andere push of pull request:** tabblad *Actions* → de run → artifact `meerwaardebelasting-apk`
  (een zip met de APK; aanmelden bij GitHub nodig).

Elke build krijgt het runnummer als `versionCode`, zodat een nieuwe APK als update over de vorige installeert –
**maar enkel als ze met dezelfde sleutel ondertekend is**. Zet daarom één keer je eigen sleutel als
repository-secrets (*Settings → Secrets and variables → Actions*):

| Secret | Inhoud |
|---|---|
| `ANDROID_KEYSTORE_B64` | de sleutel, base64: `base64 -w0 meerwaarde.jks` (maken: zie *Ondertekenen*) |
| `ANDROID_KEYSTORE_PASSWORD` | wachtwoord van de keystore |
| `ANDROID_KEY_ALIAS` | `meerwaarde` |
| `ANDROID_KEY_PASSWORD` | wachtwoord van de sleutel (leeg laten = zelfde als de keystore) |

Zonder die secrets gebruikt GitHub telkens een andere debug-sleutel: installeren lukt, maar voor een nieuwe versie
moet je de app eerst verwijderen (en verlies je de gegevens in de app – maak eerst een back-up).

## Zelf bouwen

Nodig: JDK 17 of nieuwer en de Android SDK (platform 35) – het eenvoudigst met Android Studio
(map `android/` openen), of op de opdrachtregel met Gradle 8.9 of nieuwer:

```bash
cd browser && python3 build.py && cd ../android
echo "sdk.dir=/pad/naar/Android/Sdk" > local.properties   # of ANDROID_HOME zetten
gradle assembleRelease
# APK: app/build/outputs/apk/release/app-release.apk
```

Installeren: kopieer de APK naar de telefoon en open ze (sta *installeren uit onbekende bronnen* toe voor de
bestandsbeheerder), of `adb install app-release.apk`.

## Ondertekenen

Zonder eigen sleutel wordt de APK met de debug-sleutel van die computer ondertekend. Een update over een bestaande
installatie lukt alleen met **dezelfde** sleutel; anders moet je de app eerst verwijderen en verlies je de gegevens
in de app. Maak daarom één keer een eigen sleutel en bewaar die veilig (niet in git):

```bash
keytool -genkeypair -v -keystore meerwaarde.jks -alias meerwaarde -keyalg RSA -keysize 4096 -validity 10000
```

en zet in `android/keystore.properties` (staat in `.gitignore`):

```properties
storeFile=../meerwaarde.jks
storePassword=...
keyAlias=meerwaarde
keyPassword=...
```

Verhoog `versionCode` in `app/build.gradle` bij elke nieuwe versie.
