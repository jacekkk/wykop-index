# Wykop Krach & Śmieciuch Index

Analiza sentymentu z tagu #gielda na wykop.pl: https://wykop-index.appwrite.network/

## O projekcie

Aplikacja analizuje sentyment z tagu #gielda za pomocą AI (Gemini). Składa się z trzech komponentów:

1. **wykop-index** - funkcja pobiera 100 najnowszych wpisów (z komentarzami), generuje sentyment 1-100, tworzy obrazek z wskazówką, zapisuje w bazie danych.
2. **wykop-post** - funkcja pobiera najnowszy sentyment z bazy danych i dodaje wpis na #gielda codziennie o 10:30 i 18:30 polskiego czasu.
3. **WykopIndex** - frontend pobiera najnowszy sentyment z bazy danych i pokazuje go na stronie.

## Setup/Development

```bash
# Wymagane env variables:
# APPWRITE_API_KEY, GEMINI_API_KEY, WYKOP_API_KEY, WYKOP_API_SECRET, WYKOP_REFRESH_TOKEN

npm install -g appwrite-cli # (or brew install appwrite)
appwrite -v
appwrite login
appwrite push functions # update functions
appwrite push sites # update frontend
```

**Uwaga:** Projekt edukacyjno-rozrywkowy. Nie inwestuj na podstawie sentymentu z wykop.pl ani TomekIndicator®.
