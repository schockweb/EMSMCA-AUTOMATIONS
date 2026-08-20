# Installing your email signature

Your signature file is named after you, e.g. `jane-doe.htm`.

## Outlook (Windows desktop)

1. Close Outlook.
2. Press `Win + R`, paste `%appdata%\Microsoft\Signatures` and press Enter.
3. Copy your `.htm` file into this folder.
4. Open Outlook → **File → Options → Mail → Signatures**.
5. Under *Choose default signature*, set your signature for **New messages** and
   for **Replies/forwards**.

## Outlook on the web / Microsoft 365

1. Open the `.htm` file in a web browser (double-click it).
2. Select the whole signature (`Ctrl + A`) and copy (`Ctrl + C`).
3. In Outlook web: **Settings → Mail → Compose and reply**.
4. Paste into the signature box and save.

## Gmail / Google Workspace

1. Open the `.htm` file in a browser, select all, copy.
2. Gmail → **Settings (gear) → See all settings → General → Signature**.
3. Create a new signature, paste, and scroll down to **Save Changes**.
4. Set it as the default for new mail and for replies.

## Apple Mail (Mac)

1. **Mail → Settings → Signatures**, create a new signature and put any
   placeholder text in it. Quit Mail.
2. Open Finder, press `Cmd + Shift + G`, go to
   `~/Library/Mail/V10/MailData/Signatures` (the V number varies).
3. Replace the contents of the newest `.mailsignature` file with your HTML,
   keeping the first few header lines intact.

## Notes

- **The logo will not appear until the website is live.** The signature links to
  the logo on your own domain rather than attaching it, because attached images
  show up as paperclip attachments on every email you send.
- Some recipients block images by default. The signature is designed to stay
  readable without them.
- Do not retype or reformat the signature inside Outlook — it will strip the
  formatting. Always paste the whole thing.
