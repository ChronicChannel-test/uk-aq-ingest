# Dropbox refresh token setup (UK-AQ raw payload uploads)

Use these steps to generate a Dropbox OAuth refresh token for the UK-AQ raw payload upload scripts.

## 1) Configure the Dropbox app
- Go to the Dropbox App Console and open your app.
- Ensure OAuth 2 is enabled.
- Add a Redirect URI: `https://localhost/`
  - Must match exactly (including trailing slash).

## 2) Authorize and get a code
Open this URL in a browser (replace `APP_KEY`):
```
https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&response_type=code&token_access_type=offline&redirect_uri=https://localhost/
```

After you approve, Dropbox redirects to:
```
https://localhost/?code=...&state=...
```
Copy the `code` value.

## 3) Exchange the code for a refresh token
Run this command (replace placeholders):
```
curl -X POST https://api.dropbox.com/oauth2/token \
  -d code=PASTE_CODE_HERE \
  -d grant_type=authorization_code \
  -d client_id=YOUR_APP_KEY \
  -d client_secret=YOUR_APP_SECRET \
  -d redirect_uri=https://localhost/
```

The response JSON includes a `refresh_token`.

## 4) Store the credentials
Update the repo `.env` and GitHub secrets with:
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Then verify:
```
python3 scripts/uk_aq_dropbox_test.py
```
Optional upload test:
```
python3 scripts/uk_aq_dropbox_test.py --upload
```

## Notes
- The refresh token must be created with the same app key/secret you use for uploads.
- If Dropbox returns `invalid_grant` or `refresh token is malformed`, regenerate the token and re-check for stray whitespace.
- For scoped Dropbox apps, the app folder is the root; use `/raw_data` (not `/Apps/<app>`) when setting `UK_AIR_RAW_DROPBOX_FOLDER`.
