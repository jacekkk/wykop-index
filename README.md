# Wykop Krach & Śmieciuch Index

Analiza sentymentu z tagu #gielda na wykop.pl: https://wykop-index.appwrite.network/

## O projekcie

Aplikacja analizuje sentyment z tagu #gielda za pomocą AI (Gemini). Składa się z trzech komponentów:

1. **wykop-index** - funkcja pobiera najnowsze wpisy z #gielda (z komentarzami), analizuje sentyment za pomocą AI, sprawdza sentyment Tomka (TomekIndicator®), generuje obrazek ze wskazówką, zapisuje w bazie danych i publikuje podsumowanie na Wykopie.
2. **wykop-post** - funkcja co 5 minut sprawdza powiadomienia na Wykopie, odpowiada na @ za pomocą AI i zapisuje odpowiedzi w bazie danych.
3. **WykopIndex** - frontend pobiera obecny sentyment z bazy danych, pokazuje wykres za ostatnie 30 dni oraz najnowsze odpowiedzi bota.

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

Projekt edukacyjno-rozrywkowy. Nie inwestuj na podstawie sentymentu z wykop.pl ani TomekIndicator®.
