// -----------------------------------------------------------------------------
// The texts shown to the user (feature names, connection status, action
// answers, command refusals), in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });

/** The text of a `{ en, fr }` in a language (French when missing). */
export const word = (text, language) => text?.[language] ?? text?.fr ?? String(text ?? '');

/** `{ en, fr }` -> one text with both, for the status and the action answers. */
export const join = (parts) => ({
  en: parts.map((p) => p.en).join(' '),
  fr: parts.map((p) => p.fr).join(' '),
});

export const FEATURE_NAMES = {
  door: (n) => both(`Garage door ${n}`, `Porte de garage ${n}`),
  open: (n) => both(`Open garage door ${n}`, `Ouvrir la porte de garage ${n}`),
  close: (n) => both(`Close garage door ${n}`, `Fermer la porte de garage ${n}`),
  led: both('Status LED brightness', 'Luminosité du voyant'),
};

export const T = {
  noAddress: both(
    'No Tailwind controller yet: type their IP addresses in the configuration.',
    'Aucun contrôleur Tailwind pour le moment : saisissez leurs adresses IP dans la configuration.',
  ),
  status: (answering, known) =>
    both(
      `${answering} of ${known} Tailwind controller(s) answer.`,
      `${answering} contrôleur(s) Tailwind sur ${known} répond(ent).`,
    ),
  restored: (ok, known, seconds) =>
    both(
      `${ok} of ${known} Tailwind controller(s) answered the last read before the restart; next read within ${seconds} s.`,
      `${ok} contrôleur(s) Tailwind sur ${known} avai(en)t répondu à la dernière lecture avant le redémarrage ; prochaine lecture d'ici ${seconds} s.`,
    ),
  doorsOff: both(
    'Door commands off ("Allow opening and closing the garage doors"): the doors are only read, Open and Close are refused.',
    'Commandes des portes désactivées (« Autoriser l’ouverture et la fermeture des portes de garage ») : les portes sont seulement lues, Ouvrir et Fermer sont refusés.',
  ),
  waiting: both(
    'Waiting for the first read of the controllers.',
    'En attente de la première lecture des contrôleurs.',
  ),
  invalidAddresses: (count) =>
    both(
      `${count} entry(ies) of the addresses field ignored: not an IP address or a host name (with an optional port).`,
      `${count} entrée(s) du champ des adresses ignorée(s) : pas une adresse IP ni un nom d'hôte (avec un port facultatif).`,
    ),
  key: {
    missing: both(
      'No local control key: nothing is read (the controllers answer only with the key).',
      "Pas de clé de contrôle local : rien n'est lu (les contrôleurs ne répondent qu'avec la clé).",
    ),
    invalid: both(
      'The local control key holds spaces or characters a controller cannot take: not used.',
      "La clé de contrôle local contient des espaces ou des caractères qu'un contrôleur ne peut pas prendre : non utilisée.",
    ),
  },
  keyRefused: (list) =>
    both(
      `Local control key refused by ${list.join(', ')}: not read any more with it. Check the key in the Tailwind web app, save it again, or press "Check the controllers" once it is fixed.`,
      `Clé de contrôle local refusée par ${list.join(', ')} : plus lu avec cette clé. Vérifiez la clé dans l'application web Tailwind, enregistrez-la à nouveau, ou appuyez sur « Vérifier les contrôleurs » une fois corrigée.`,
    ),
  paused: (list) =>
    both(
      `Asked to wait (HTTP 429 or 5xx): ${list.join(', ')}.`,
      `Demande d'attendre (HTTP 429 ou 5xx) : ${list.join(', ')}.`,
    ),
  notController: (list) =>
    both(
      `Not a Tailwind controller (no device id in its status): ${list.join(', ')}.`,
      `Pas un contrôleur Tailwind (pas d'identifiant dans son état) : ${list.join(', ')}.`,
    ),
  oldFirmware: (list) =>
    both(
      `Firmware too old for the local API (10.10 at least, update it in the Tailwind app): ${list.join(', ')}.`,
      `Micrologiciel trop ancien pour l'API locale (10.10 au moins, mettez-le à jour dans l'application Tailwind) : ${list.join(', ')}.`,
    ),
  sameController: (id, list) =>
    both(
      `The same controller (${id}) answers at ${list.join(' and ')}: only the first one is used.`,
      `Le même contrôleur (${id}) répond à ${list.join(' et ')} : seule la première adresse sert.`,
    ),
  guardUnsaved: both(
    'Could not write to /data: the guard of the last door command is kept in memory only (a restart within 45 s would lose it).',
    "Écriture impossible dans /data : la garde de la dernière commande de porte n'est gardée qu'en mémoire (un redémarrage dans les 45 s la perdrait).",
  ),
  moved: (address, previous, next) =>
    both(
      `${address}: ${previous} was there, ${next} answers now. Give each controller a fixed address in your router.`,
      `${address} : ${previous} y était, ${next} y répond maintenant. Donnez une adresse fixe à chaque contrôleur dans votre box.`,
    ),
  check: {
    none: both(
      'No address in the configuration: type the IP addresses of your controllers.',
      'Aucune adresse dans la configuration : saisissez les adresses IP de vos contrôleurs.',
    ),
    noKey: both(
      'No usable local control key in the configuration: nothing read.',
      "Pas de clé de contrôle local utilisable dans la configuration : rien n'a été lu.",
    ),
    result: (lines) => both(lines.map((l) => l.en).join('\n'), lines.map((l) => l.fr).join('\n')),
    ok: (address, id, age) =>
      both(`${address}: ${id}, read ${age} s ago.`, `${address} : ${id}, lu il y a ${age} s.`),
    failed: (address, reason, age) =>
      both(
        `${address}: no answer (${reason}), ${age} s ago.`,
        `${address} : pas de réponse (${reason}), il y a ${age} s.`,
      ),
    refused: (address) =>
      both(`${address}: local control key refused.`, `${address} : clé de contrôle local refusée.`),
    pending: (address) => both(`${address}: not read yet.`, `${address} : pas encore lu.`),
    interval: (seconds) =>
      both(
        `(Never read sooner than every ${seconds} s.)`,
        `(Jamais lu plus souvent que toutes les ${seconds} s.)`,
      ),
  },
};

/** The command refusals and errors (one language, the configured one). */
export const ERRORS = {
  readOnly: both('This feature cannot be controlled.', 'Cette fonctionnalité ne se commande pas.'),
  badValue: both('Invalid value.', 'Valeur invalide.'),
  unknownDevice: both(
    'This controller or door is not known, or no longer at its address: nothing sent.',
    "Contrôleur ou porte inconnu, ou plus à son adresse : rien n'a été envoyé.",
  ),
  openDisabled: both(
    'Opening the garage doors is disabled in the configuration ("Allow opening and closing the garage doors"): nothing sent.',
    "L'ouverture des portes de garage est désactivée dans la configuration (« Autoriser l’ouverture et la fermeture des portes de garage ») : rien n'a été envoyé.",
  ),
  closeDisabled: both(
    'Closing pulses the door opener as opening does (a door that moved since it was read could stop or reverse): it needs "Allow opening and closing the garage doors" in the configuration. Nothing sent.',
    "Fermer envoie une impulsion à la motorisation comme ouvrir (une porte qui a bougé depuis sa lecture pourrait s'arrêter ou repartir) : il faut « Autoriser l’ouverture et la fermeture des portes de garage » dans la configuration. Rien n'a été envoyé.",
  ),
  noKey: both(
    'No usable local control key in the configuration: nothing sent.',
    "Pas de clé de contrôle local utilisable dans la configuration : rien n'a été envoyé.",
  ),
  keyRefused: both(
    'The controller refused the local control key: nothing sent. Check the key, then save it again.',
    "Le contrôleur a refusé la clé de contrôle local : rien n'a été envoyé. Vérifiez la clé, puis enregistrez-la à nouveau.",
  ),
  keyRefusedNow: both(
    'The controller refused the local control key: the door did not move. Check the key in the Tailwind web app.',
    "Le contrôleur a refusé la clé de contrôle local : la porte n'a pas bougé. Vérifiez la clé dans l'application web Tailwind.",
  ),
  cancelled: both(
    'Cancelled by a close command: nothing sent.',
    "Annulée par une commande de fermeture : rien n'a été envoyé.",
  ),
  configChanged: both(
    'The configuration changed meanwhile: nothing sent.',
    "La configuration a changé entre-temps : rien n'a été envoyé.",
  ),
  tooSlow: both(
    'The controller did not answer in time: nothing sent.',
    "Le contrôleur n'a pas répondu à temps : rien n'a été envoyé.",
  ),
  blocked: both(
    'The controller asked to wait: nothing sent.',
    "Le contrôleur a demandé d'attendre : rien n'a été envoyé.",
  ),
  unknownState: both(
    'The state of the door could not be read just now: nothing sent.',
    "L'état de la porte n'a pas pu être lu à l'instant : rien n'a été envoyé.",
  ),
  oldFirmware: both(
    'The firmware of the controller is too old for the local API (10.10 at least): nothing sent.',
    "Le micrologiciel du contrôleur est trop ancien pour l'API locale (10.10 au moins) : rien n'a été envoyé.",
  ),
  doorDisabled: both(
    'This door is disabled in the Tailwind app: nothing sent.',
    "Cette porte est désactivée dans l'application Tailwind : rien n'a été envoyé.",
  ),
  doorLockedOut: both(
    'This door is locked out by the controller (its own safety): nothing sent. Use the wall button or the remote control.',
    "Cette porte est bloquée par le contrôleur (sa propre sécurité) : rien n'a été envoyé. Utilisez le bouton mural ou la télécommande.",
  ),
  notClosed: both(
    'The door is not read closed (unknown): nothing sent.',
    "La porte n'est pas lue fermée (état inconnu) : rien n'a été envoyé.",
  ),
  notOpen: both(
    'The door is not read open (unknown): nothing sent. Use the wall button or the remote control.',
    "La porte n'est pas lue ouverte (état inconnu) : rien n'a été envoyé. Utilisez le bouton mural ou la télécommande.",
  ),
  justCommanded: both(
    'The door was commanded just now and is not read where that command sends it yet: another pulse would stop or reverse it, so nothing was sent. Try again once it has moved, or use the wall button or the remote control.',
    "La porte vient d'être commandée et n'est pas encore lue là où cette commande l'envoie : une autre impulsion l'arrêterait ou l'inverserait, rien n'a donc été envoyé. Réessayez quand elle aura bougé, ou utilisez le bouton mural ou la télécommande.",
  ),
  ledBusy: both(
    'A brightness change of this LED is already in progress: nothing sent.',
    "Un changement de luminosité de ce voyant est déjà en cours : rien n'a été envoyé.",
  ),
  ledTooSoon: both(
    'The LED brightness was changed less than 2 s ago: nothing sent. Try again in a moment.',
    "La luminosité du voyant a été changée il y a moins de 2 s : rien n'a été envoyé. Réessayez dans un instant.",
  ),
  doorBusy: both(
    'Another opening of this door is still in progress: nothing sent.',
    "Une autre ouverture de cette porte est encore en cours : rien n'a été envoyé.",
  ),
  tooSoon: both(
    'The same opening was answered a moment ago (the door was read open then): nothing sent, nothing read again. Try again in a few seconds.',
    "La même ouverture a été traitée il y a un instant (la porte était alors lue ouverte) : rien n'a été envoyé ni relu. Réessayez dans quelques secondes.",
  ),
  tooSoonRefused: (reason) =>
    both(
      `The same opening was refused a moment ago (${reason}): nothing sent, nothing read again. Try again in a few seconds.`,
      `La même ouverture a été refusée il y a un instant (${reason}) : rien n'a été envoyé ni relu. Réessayez dans quelques secondes.`,
    ),
  notSent: (reason) => both(`Command not sent (${reason}).`, `Commande non envoyée (${reason}).`),
  refused: both(
    'The controller refused the command ("Fail"): the door did not move.',
    "Le contrôleur a refusé la commande (« Fail ») : la porte n'a pas bougé.",
  ),
  refusedHttp: (reason) =>
    both(
      `The controller refused the command (${reason}).`,
      `Le contrôleur a refusé la commande (${reason}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the door in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez la porte dans quelques secondes.`,
    ),
  ledUnconfirmed: both(
    'Brightness sent, without confirmation (not read back yet): check it in a few seconds.',
    'Luminosité envoyée, sans confirmation (pas encore relue) : vérifiez-la dans quelques secondes.',
  ),
};
