// A charger EN PREMIER dans chaque contexte, avant tout autre script du depot.
//
// FILET DE SECURITE, PAS LE CORRECTIF D'UN BUG CONSTATE. Verifie en conditions reelles sur
// Firefox 153.0 : chrome.* y rend deja de vraies promesses, exactement comme browser.*, donc
// les ~29 chaines .then() du depot fonctionnent telles quelles, sans ce fichier.
//
// Pourquoi l'ajouter quand meme : ce comportement n'est documente NULLE PART. MDN et Extension
// Workshop disent seulement que chrome.* ACCEPTE les callbacks — jamais qu'il rend une
// promesse quand on omet le callback. C'est un detail d'implementation (une seule
// implementation promise-based, le callback n'en etant qu'une enveloppe optionnelle), pas un
// contrat. Une surface non documentee peut changer sans note de version, et la panne serait
// ici totale et silencieuse : les 29 sites levant TypeError d'un coup, dans tous les contextes
// a la fois. On aliase donc sur browser.*, qui est documente.
//
// Ne peut rien casser, par construction :
//   - Firefox      : l'alias reussit et tout le depot passe sur la surface documentee ;
//   - Chrome ≥ 148 : "browser" existe AUSSI depuis cette version et expose les MEMES objets
//     d'API que "chrome" (chrome.tabs === browser.tabs, documente par Google), donc l'alias
//     s'y fait mais ne change rien au comportement. Mesure faite sur Chrome 150 : les deux
//     objets de PREMIER niveau restent distincts (chrome === browser vaut false), seules les
//     sous-API sont partagees — ne pas se servir de "chrome === browser" comme preuve que ce
//     fichier a tourne quelque part, ce n'en est pas une ;
//   - Chrome < 148 : "browser" n'existe pas, la condition est fausse, ce fichier ne fait RIEN ;
//   - si le global n'etait pas assignable, le catch nous laisse sur le chrome.* natif,
//     c'est-a-dire exactement l'etat qui fonctionne aujourd'hui.
//
// ⚠️ Une seule condition connue desactive "browser" cote Chrome : declarer un devtools_page
// eteint le namespace pour TOUTE l'extension. On n'en a pas. Si on en ajoutait un, la
// condition ci-dessous deviendrait fausse et on retomberait sur chrome.* natif — degradation
// propre, mais a savoir.
//
// ⚠️ CONSEQUENCE A NE PAS OUBLIER EN ECRIVANT DU CODE : apres cet alias, "chrome.*" EST
// "browser.*", qui est promise-only cote Firefox et refuse un argument callback surnumeraire.
// Tout appel en style callback devient donc suspect. Le depot n'en compte qu'UN SEUL,
// show() dans background.js — partout ailleurs c'est du .then(). Ne pas en reintroduire.
//
// ⚠️ Ce fichier est evalue UNE FOIS PAR ENTREE content_scripts, soit six fois par frame, dans
// le meme monde isole. Il doit donc rester strictement idempotent : aucun compteur, aucun log,
// aucun effet de bord cumulatif ici.
//
// Volontairement sans 'use strict' et sans IIFE : il faut assigner le global "chrome" lui-meme,
// que tout le reste du depot appelle sous ce nom. C'est ce qui evite d'avoir a renommer les
// ~150 occurrences de "chrome." en un nom d'alias.
try {
  if (typeof browser !== 'undefined' && browser.runtime) chrome = browser;
} catch (e) { /* global non assignable : on garde le chrome.* natif */ }
