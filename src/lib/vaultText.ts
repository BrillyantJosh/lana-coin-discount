/**
 * The words of the saved-key panels (components/KeyVaultPanel.tsx), in English and Slovenian — this app has no
 * i18next; the sign-in page passes its own language. The same texts as the other LanaPays.Us apps (key `vault.*`).
 */
export type VaultLang = 'en' | 'sl';

const TEXT = {
  "en": {
    "savedTitle": "Key saved on this device",
    "unlockPasskey": "Unlock with passkey",
    "unlockPassword": "Unlock",
    "password": "Password of the saved key",
    "passwordPlaceholder": "Password of the saved key",
    "unlockHint": "Encrypted on this device only. Once unlocked it stays in this tab and is forgotten after 15 minutes without use.",
    "remove": "Remove the saved key from this device",
    "removeConfirmText": "To remove it, unlock it once more. Keep your key (card or paper) somewhere safe: without it you cannot sign in.",
    "removeConfirm": "Unlock and remove",
    "cancel": "Cancel",
    "orOtherKey": "or sign in with a key",
    "saveLabel": "Save my key encrypted on this device",
    "saveHint": "Next time: unlock with a passkey (Face ID, Touch ID, iCloud Keychain) or a password, without your card.",
    "noSaveHint": "Not saved: the key stays only in this tab until you close it or sign out.",
    "methodPasskey": "Passkey (Face ID, Touch ID, iCloud Keychain)",
    "methodPassword": "Password",
    "newPassword": "New password for the saved key",
    "repeatPassword": "Repeat the password",
    "passwordRule": "At least 14 characters, not only digits. It cannot be recovered: if you forget it, sign in with your key again.",
    "lockedTitle": "Unlock your key",
    "lockedText": "Your key is not in this tab any more (page reloaded, or 15 minutes without use).",
    "otherKey": "Sign in with another key",
    "signOut": "Sign out",
    "error": {
      "invalid_record": "The saved key on this device is damaged. Sign in with your key again.",
      "invalid_key": "That is not a valid private key.",
      "other_identity": "The saved key belongs to someone else.",
      "password_long": "The password is too long.",
      "password_weak": "The password must have at least 14 characters and not only digits.",
      "password_mismatch": "The two passwords are not the same.",
      "storage_refused": "This browser does not allow saving (private mode?).",
      "already_saved": "A key is already saved on this device. Remove it first, then save another.",
      "changed_elsewhere": "The saved key was changed in another tab. Reload the page and try again.",
      "nothing_saved": "No key is saved on this device.",
      "unlock_failed": "Could not unlock: wrong password, or the passkey did not match.",
      "passkey_unavailable": "This browser has no passkeys here. Choose a password instead.",
      "passkey_no_prf": "This passkey cannot protect a key (no PRF). Choose a password instead.",
      "passkey_cancelled": "The passkey was cancelled.",
      "verify_failed": "Saving could not be checked; nothing was saved.",
      "cancelled": "Cancelled."
    }
  },
  "sl": {
    "savedTitle": "Ključ, shranjen na tej napravi",
    "unlockPasskey": "Odkleni s passkeyem",
    "unlockPassword": "Odkleni",
    "password": "Geslo shranjenega ključa",
    "passwordPlaceholder": "Geslo shranjenega ključa",
    "unlockHint": "Šifriran samo na tej napravi. Ko ga odkleneš, ostane v tem zavihku in se po 15 minutah nerabe pozabi.",
    "remove": "Odstrani shranjeni ključ s te naprave",
    "removeConfirmText": "Za odstranitev ga še enkrat odkleni. Svoj ključ (kartico ali papir) hrani na varnem: brez njega se ne moreš prijaviti.",
    "removeConfirm": "Odkleni in odstrani",
    "cancel": "Prekliči",
    "orOtherKey": "ali se prijavi s ključem",
    "saveLabel": "Shrani moj ključ šifrirano na tej napravi",
    "saveHint": "Naslednjič: odkleni s passkeyem (Face ID, Touch ID, iCloud Keychain) ali z geslom, brez kartice.",
    "noSaveHint": "Ni shranjen: ključ ostane samo v tem zavihku, dokler ga ne zapreš ali se ne odjaviš.",
    "methodPasskey": "Passkey (Face ID, Touch ID, iCloud Keychain)",
    "methodPassword": "Geslo",
    "newPassword": "Novo geslo za shranjeni ključ",
    "repeatPassword": "Ponovi geslo",
    "passwordRule": "Vsaj 14 znakov, ne samo številke. Gesla ni mogoče obnoviti: če ga pozabiš, se znova prijavi s ključem.",
    "lockedTitle": "Odkleni svoj ključ",
    "lockedText": "Tvojega ključa ni več v tem zavihku (stran osvežena ali 15 minut nerabe).",
    "otherKey": "Prijava z drugim ključem",
    "signOut": "Odjava",
    "error": {
      "invalid_record": "Shranjeni ključ na tej napravi je poškodovan. Znova se prijavi s ključem.",
      "invalid_key": "To ni veljaven zasebni ključ.",
      "other_identity": "Shranjeni ključ pripada nekomu drugemu.",
      "password_long": "Geslo je predolgo.",
      "password_weak": "Geslo mora imeti vsaj 14 znakov in ne sme biti samo iz številk.",
      "password_mismatch": "Gesli se ne ujemata.",
      "storage_refused": "Ta brskalnik ne dovoli shranjevanja (zasebni način?).",
      "already_saved": "Na tej napravi je že shranjen ključ. Najprej ga odstrani, nato shrani drugega.",
      "changed_elsewhere": "Shranjeni ključ je bil spremenjen v drugem zavihku. Osveži stran in poskusi znova.",
      "nothing_saved": "Na tej napravi ni shranjenega ključa.",
      "unlock_failed": "Odklep ni uspel: napačno geslo ali passkey se ne ujema.",
      "passkey_unavailable": "Ta brskalnik tu nima passkeyev. Izberi geslo.",
      "passkey_no_prf": "Ta passkey ne more zaščititi ključa (brez PRF). Izberi geslo.",
      "passkey_cancelled": "Passkey je bil preklican.",
      "verify_failed": "Shranjevanja ni bilo mogoče preveriti; nič ni shranjeno.",
      "cancelled": "Preklicano."
    }
  }
} as const;

type Tree = { [k: string]: string | Tree };

/** t('vault.savedTitle'), t('vault.error.unlock_failed', { defaultValue }) — in `lang`, else English. */
export function vaultT(lang: VaultLang) {
  return (key: string, opts?: { defaultValue?: string }): string => {
    const path = key.replace(/^vault\./, '').split('.');
    const find = (root: Tree): string | undefined => {
      let node: string | Tree | undefined = root;
      for (const part of path) node = typeof node === 'object' && node ? node[part] : undefined;
      return typeof node === 'string' ? node : undefined;
    };
    return find(TEXT[lang] as unknown as Tree) ?? opts?.defaultValue ?? find(TEXT.en as unknown as Tree) ?? key;
  };
}
