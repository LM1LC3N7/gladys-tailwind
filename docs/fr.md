# Tailwind

Intégration Gladys pour les contrôleurs de porte de garage **Tailwind** (iQ3,
Light), sur votre réseau local : l'état de chaque porte de garage, des boutons
Ouvrir et Fermer, et la luminosité du voyant, par l'API locale du contrôleur,
sans le cloud Tailwind.

> **Jamais testé avec un vrai appareil.** Cette première version a été écrite
> à partir de la bibliothèque `gotailwind` (celle de l'intégration Home
> Assistant) et testée seulement contre des contrôleurs simulés. Vos retours
> sont les bienvenus.
>
> Intégration non officielle, sans lien avec Tailwind.

## Ce qu'il faut

- Un contrôleur Tailwind avec le micrologiciel **10.10 ou plus récent** (à
  mettre à jour dans l'application Tailwind), sur le même réseau que Gladys.
- Une **adresse IP fixe** pour chaque contrôleur (une réservation DHCP dans
  votre box).
- Votre **clé de contrôle local** : connectez-vous à l'application web
  Tailwind (web.gotailwind.com) avec votre compte Tailwind, et copiez la
  « Local Control Key » (six caractères, par exemple 123456). Elle est la même pour tous les
  contrôleurs du compte. Gladys ne parle jamais au cloud Tailwind : vous y
  lisez seulement la clé.

## Configuration

1. Dans Gladys, ouvrez la configuration de l'intégration.
2. Saisissez les adresses IP de vos contrôleurs, séparées par des virgules.
3. Collez la clé de contrôle local. Ce champ est gardé par Gladys dans sa
   base, jamais réaffiché, et envoyé seulement à vos contrôleurs, en clair
   sur votre réseau local (leur API locale n'a pas de https).
4. Enregistrez, puis ajoutez les contrôleurs depuis l'onglet **Découverte**.

La ligne d'état indique combien de contrôleurs répondent. **Vérifier les
contrôleurs** affiche ce que chaque adresse a répondu.

## Ce que vous obtenez

Un appareil Gladys par contrôleur (identifié par son adresse MAC : une
nouvelle adresse IP ne change rien), avec pour chaque porte qu'il gère (1 à 3) :

| Fonctionnalité                | Type                | Remarques                                                   |
| ----------------------------- | ------------------- | ----------------------------------------------------------- |
| Porte de garage _n_           | capteur d'ouverture | ouverte ou fermée ; rien n'est publié si l'état est inconnu |
| Ouvrir la porte de garage _n_ | bouton              | refusé tant que non autorisé (voir plus bas)                |
| Fermer la porte de garage _n_ | bouton              | refusé tant que non autorisé (voir plus bas)                |

et **Luminosité du voyant** (0 à 100), qui ne demande aucune autorisation. Un
changement de luminosité n'est confirmé que lorsque le voyant est relu à la
valeur demandée ; sinon Gladys répond « envoyée, sans confirmation ».

## Sécurité des commandes

Un contrôleur Tailwind ouvre et ferme une porte en envoyant une impulsion à
l'entrée bouton mural de la motorisation. Sur la plupart des motorisations,
cette entrée est une **bascule** : une impulsion donnée à une porte qui a
bougé depuis sa lecture peut l'arrêter ou l'inverser. Donc :

- **Ouvrir** et **Fermer** sont tous deux **refusés par défaut**. Activez
  « Autoriser l’ouverture et la fermeture des portes de garage » pour les
  utiliser (depuis le tableau de bord, les scènes et les assistants vocaux).
  L'autorisation est vérifiée à l'arrivée de la commande, après la lecture de
  la porte et juste avant le départ de la requête.
- La porte n'est jamais un interrupteur : un « éteins tout » d'un assistant
  vocal ou d'une scène ne peut jamais l'atteindre.
- Gladys lit le contrôleur juste avant chaque commande et vérifie que c'est
  bien le même (adresse MAC). **Ouvrir** n'est envoyé qu'à une porte lue
  fermée, **Fermer** qu'à une porte lue ouverte ; déjà dans cet état : rien
  n'est envoyé. Une porte dans un état inconnu, désactivée dans l'application
  Tailwind ou bloquée par le contrôleur est refusée.
- Après une commande, la suivante de cette porte attend que la porte soit lue
  là où elle a été envoyée : **30 s au moins après une ouverture** (le capteur
  lit « ouverte » dès que la porte quitte la position fermée, bien avant la
  fin d'une course qui peut durer 30 s), 15 s après une fermeture (« fermée »
  n'est lu qu'en fin de course), 45 s au plus. Cette garde est écrite dans
  les fichiers de l'intégration avant le départ de la requête : un
  redémarrage la conserve ; elle est mesurée sur une horloge qu'un changement
  de l'heure du système ne déplace pas.
- Un **Fermer** n'attend jamais derrière une autre commande, de sa porte ou
  d'une autre : fermer trois portes à la fois envoie trois commandes. Il
  annule les ouvertures de sa porte pas encore parties. Il n'est jamais
  retenu par une pause demandée par le contrôleur (HTTP 429 ou 5xx) ni par une
  clé refusée : il a un essai, jamais renouvelé. Les ouvertures d'une même
  porte passent une à une.
- Le même bouton pressé à nouveau sur la même porte dans les 5 s d'un appui
  qui n'a rien envoyé (porte déjà dans cet état, ou refus) reçoit la même
  réponse sans relire le contrôleur : une scène en boucle ne le submerge
  jamais. La luminosité du voyant change au plus une fois toutes les 2 s.
- Une commande part dans les 3,5 s du clic ou est refusée sans rien envoyer.
  Si elle a pu atteindre le contrôleur sans réponse, Gladys indique
  « envoyée, sans confirmation » et relit la porte ; elle n'est jamais
  renvoyée. Une réponse positive signifie que le contrôleur a accepté la
  commande : la porte bouge ensuite pendant 10 à 30 s et son état suit dans
  Gladys.

## Limites

- Lecture périodique seulement (toutes les 10 s par défaut, de 5 s à 300 s),
  jamais plus souvent que l'intervalle, même après un redémarrage. HTTP 429 ou
  5xx : une pause de 1 min à 6 h.
- Une clé refusée par un contrôleur l'est définitivement pour ce contrôleur :
  il n'est plus lu avec cette clé tant que vous n'en enregistrez pas une autre,
  ou que vous n'appuyez pas sur « Vérifier les contrôleurs » une fois la clé
  corrigée (une lecture, jamais plus souvent que l'intervalle). La clé n'est
  jamais écrite dans les journaux ni dans les fichiers de l'intégration :
  seuls 8 bits d'une empreinte salée d'une clé refusée sont gardés (on ne
  peut pas en retrouver la clé), effacés au premier succès. Une entrée du
  champ des adresses qui n'est pas une adresse n'est jamais affichée dans
  l'état, seulement comptée.
- Le mode nuit, les notifications envoyées par le contrôleur et la découverte
  mDNS ne sont pas encore pris en charge.
- La plupart des contrôleurs Tailwind sont vendus en Amérique du Nord :
  l'intégration peut avoir peu d'utilité ailleurs.
