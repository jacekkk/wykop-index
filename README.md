# Wykop Krach & Śmieciuch Index

Analiza sentymentu z tagu #gielda na wykop.pl: https://wykop-index.appwrite.network/

## O projekcie

Aplikacja analizuje sentyment z tagu #gielda za pomocą AI (OpenRouter lub Gemini). Składa się z trzech komponentów:

1. **wykop-index** - funkcja pobiera najnowsze wpisy z #gielda (z komentarzami), analizuje sentyment za pomocą AI, sprawdza sentyment Tomka (TomekIndicator®), generuje obrazek ze wskazówką, zapisuje w bazie danych i publikuje podsumowanie na Wykopie.
2. **wykop-post** - funkcja co 5 minut sprawdza powiadomienia na Wykopie, odpowiada na @ za pomocą Gemini i zapisuje odpowiedzi w bazie danych.
3. **WykopIndex** - frontend pobiera obecny sentyment z bazy danych, pokazuje historyczne wykresy, statystyki oraz najnowsze odpowiedzi bota.

## Setup/Development

Frontend local dev:
```bash
cd sites/WykopIndex/
cp .env.example .env
npm install
npm run dev
```

Appwrite deployment:
```bash
npm install -g appwrite-cli # (or brew install appwrite)
appwrite -v
appwrite login
appwrite push functions # update functions
appwrite push sites # update frontend
```

Zmiany w funkcjach, `appwrite.config.json` lub workflow wdrożenia trafiające do
`main` (w tym przez merge PR) automatycznie wdrażają obie funkcje po testach.
Workflow **Deploy Appwrite functions** można też uruchomić ręcznie.

Konfiguracja dostawców AI (Gemini dla sentymentu z zapasowym OpenRouter,
Gemini dla odpowiedzi i filmów), obsługa
wyszukiwania i multimediów oraz testy: [functions/AI_PROVIDERS.md](functions/AI_PROVIDERS.md).

Osobne harmonogramy Cloudflare Workers dla indeksu i odpowiedzi (konfiguracja, testy i wdrożenie):
[cloudflare/wykop-scheduler](cloudflare/wykop-scheduler/README.md).
Harmonogramy GitHub Actions są wyłączone; uruchomienia ręczne pozostają dostępne.
Worker indeksu zachowuje nazwę `wykop-scheduler` i stan ponowień. Nowy
`wykop-post-scheduler` jest początkowo wyłączony; instrukcja opisuje przeniesienie
harmonogramu odpowiedzi i ustawienie jego sekretu. Każdy Worker wdraża się osobno.

Projekt edukacyjno-rozrywkowy. Nie inwestuj na podstawie sentymentu z wykop.pl ani TomekIndicator®.
