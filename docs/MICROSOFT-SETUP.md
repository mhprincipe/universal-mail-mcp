# Setting up Microsoft sign-in (Outlook.com)

Universal Mail 2.5 can add Outlook.com, Hotmail, Live and MSN accounts. Microsoft
has no app passwords for these, so each account is approved at microsoft.com
with a short code instead. For that, Universal Mail needs to be **registered
with Microsoft once**, by its publisher. This page is that one-time job: about
30 minutes, free.

Until it's done, everything else works as before, and the Outlook.com option
simply doesn't appear on your page.

## Before you start: a Microsoft directory

Microsoft no longer lets a personal account register an app on its own. The
registration has to live in a **Microsoft Entra directory** (a tenant). If your
business already has Microsoft 365, it has one: use it. Otherwise, the usual
free way to get one is:

1. Go to [azure.microsoft.com/free](https://azure.microsoft.com/free) and sign
   up with the Microsoft account you want to own the registration.
2. Azure asks for your details and a card to confirm who you are. Nothing is
   charged for what's below: app registrations are free.
3. When it's done, you have a **Default Directory**.

(Microsoft's 365 Developer Program also gives a directory, if you qualify.)

## The registration

1. Open [entra.microsoft.com](https://entra.microsoft.com) and sign in.
2. **Applications → App registrations → New registration.**
   - **Name:** `Universal Mail`
   - **Supported account types:** *Personal Microsoft accounts only*
   - **Redirect URI:** leave empty.
   - **Register.**
3. On the new app's page: **Authentication → Advanced settings → Allow public
   client flows: Yes → Save.** (This allows the sign-in code. There is no
   secret: none is needed, and none should be made.)
4. **API permissions:** nothing to add. Universal Mail asks for exactly what it
   needs when someone signs in: read mail (IMAP), send mail (SMTP), and stay
   signed in. If a sign-in ever says a permission is missing, add these under
   **API permissions → Add a permission → APIs my organization uses → Office 365
   Exchange Online → Delegated**: `IMAP.AccessAsUser.All` and `SMTP.Send`.
5. **Overview:** copy the **Application (client) ID**. It looks like
   `0a1b2c3d-…`. It isn't a secret: paste it to Claude.

## Turning it on for your server

The app id is a setting on your server (`MICROSOFT_CLIENT_ID`), so no new
version is needed. In Cloud Shell:

```bash
gcloud run services update universal-mail --region=us-central1 --project=YOUR-PROJECT --update-env-vars=MICROSOFT_CLIENT_ID=THE-ID-YOU-COPIED
```

(Claude can run this for you when you allow it.) Your page then shows **Add an
Outlook.com account**.

## Adding your Outlook.com account

1. Your page → **Add an Outlook.com account** → your address → **Sign in with
   Microsoft**.
2. The page shows a code and a link. Open the link, type the code, sign in as
   that account, and approve **Universal Mail**. Microsoft may say the app is
   from an **unverified publisher**: that's expected until the business is
   verified with Microsoft (it needs the registered business, as selling does).
3. Back on your page, press **Finish**. Universal Mail checks reading and
   sending, as it does for every account, and adds it.
4. Give your AI apps permission for it (**Connected apps → Permissions**).

You can remove Universal Mail's access at any time: on your page (**Remove**), or
at Microsoft ([account.microsoft.com](https://account.microsoft.com) → Privacy
→ Apps and services).

## What it can't do yet

- **Work and school accounts** (Microsoft 365 at a company): their
  administrators often turn off IMAP or outside apps. Not offered yet.
- If Microsoft stops accepting the sign-in (a changed password, access
  removed), the account turns amber, you get an email, and **Sign in again** on
  your page mends it.
