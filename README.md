# Wykop Krach & Śmieciuch Index

Analiza sentymentu z #gielda na wykop.pl: https://wykop-index.appwrite.network/

## O projekcie

Dashboard analizujący sentyment z tagu #gielda za pomocą Google Gemini AI. Projekt składa się z trzech komponentów:

1. **wykop-index** - funkcja analizująca (Node.js): pobiera 100 wpisów, generuje sentyment 1-100, tworzy obrazek z wskazówką.
2. **wykop-post** - funkcja publikująca (Node.js): dodaje posta na Wykop.pl #gielda z obecnym sentymentem.
3. **WykopIndex** - frontend (React): wykres, historia, trendy.

## Setup

```bash
# Wymagane env variables:
# APPWRITE_API_KEY, GEMINI_API_KEY, WYKOP_API_KEY, WYKOP_API_SECRET

npm install -g appwrite
appwrite login
appwrite push functions
appwrite push sites
```

**Disclaimer:** Projekt edukacyjno-rozrywkowy. Nie inwestuj na podstawie sentymentu z wykop.pl ani TomekIndicator®.
