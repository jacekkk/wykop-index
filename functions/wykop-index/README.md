# wykop-index

Sentiment analysis uses OpenRouter first, with Gemini as fallback. Tomek video
analysis uses Gemini. Provider configuration and tests: [AI_PROVIDERS.md](../AI_PROVIDERS.md).

The index posts subscriber mentions in groups of up to 50, the limit for the
bot's orange Wykop account. If Wykop rejects a batch or its submission cannot
be confirmed, the function logs the batch number and saves the published index
entry. [Wykop account limits](https://wykop.pl/faq/konto#limity-na-koncie)
