# Contexte du projet

Extension Chrome (Manifest V3) personnelle, jamais destinée au Web Store, qui affiche :
1. L'usage de session (5h) et hebdomadaire (7j) sur claude.ai
2. Le % de contexte utilisé dans la conversation en cours (feature absente des outils existants)

## Structure du repo

Note : le repo public de ClaudeKarma (jrlprost/ClaudeKarma et jrlprost/claudekarma_browser)
est introuvable (404 sur les deux adresses) — pas de code de référence externe disponible.
On construit donc sans s'appuyer sur son code, uniquement à partir de la découverte réseau
qu'on fait nous-mêmes (Phase 1).

- Tout le repo = notre propre extension, développée en 2 phases :
  - **Phase 1 (sniffer)** : extension de découverte qui intercepte fetch/XHR sur claude.ai
    pour trouver les vrais endpoints/formats d'usage et de contexte (rien n'est documenté
    publiquement par Anthropic).
  - **Phase 2 (finale)** : extension avec service worker (polling via chrome.alarms),
    icône de toolbar dynamique, popup, et si possible un badge de contexte sur les pages
    de conversation — une fois le schéma réel connu depuis la Phase 1.

## Contraintes techniques

- Manifest V3 uniquement, JS vanilla, pas de build step (chargeable directement en mode
  développeur via chrome://extensions).
- Toutes les données restent en local (chrome.storage.local) — jamais de serveur externe.
- Les endpoints internes de claude.ai ne sont pas garantis stables : le code doit rester
  simple à corriger si un format de réponse change.

---

# Behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
