# Midj

This is the first piece of Midj: a small Node.js TypeScript server that receives
WhatsApp Cloud API webhooks. It answers the GET verification handshake and, for each
incoming text message in a POST, returns a reply (`"Midj received: " + text`) in the
JSON response. It does not send anything to WhatsApp or anywhere else.

## Requirements

- Node.js 22.18 or later. The TypeScript files run directly through Node.js's
  built-in type stripping.
- Nothing to install: the project has no dependencies, so `npm install` is not needed.

## Start the server

Set `WHATSAPP_VERIFY_TOKEN`, then run `npm start`:

```sh
WHATSAPP_VERIFY_TOKEN=example-verify-token npm start
```

`PORT` is optional and defaults to 3000:

```sh
WHATSAPP_VERIFY_TOKEN=example-verify-token PORT=8080 npm start
```

When it starts, the server prints `midj listening on port 3000` (or the port you chose).
If `WHATSAPP_VERIFY_TOKEN` is missing or empty, or `PORT` is not a number from 1 to
65535, it prints an error and exits with code 1.

## Run the tests

```sh
npm test
```

Run `npm run prove` (no keys needed) to run all tests, then one fake sale from voice note to held, released and refunded payments.

## Examples

GET handshake (with the server started using `example-verify-token`):

```sh
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=example-verify-token&hub.challenge=example-challenge"
```

Response: `200` with the plain-text body `example-challenge`. A wrong token gets
`403 {"error":"forbidden"}`.

POST a text message:

```sh
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"object":"whatsapp_business_account","entry":[{"id":"example-account-id","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","messages":[{"from":"15550000001","id":"wamid.example-1","timestamp":"1700000000","type":"text","text":{"body":"Hello Midj"}}]}}]}]}'
```

Response (`200`):

```json
{"replies":[{"to":"15550000001","text":"Midj received: Hello Midj"}]}
```

Payloads without text messages (for example delivery statuses) get `{"replies":[]}`.

## Not part of this piece

- Checking the `X-Hub-Signature-256` header.
- Sending real WhatsApp messages.
- Payments.

All tokens, phone numbers and IDs in this project are synthetic example data.
