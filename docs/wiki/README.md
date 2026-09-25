# Wiki source

These files are the GitHub wiki. The wiki is a separate git repository (`keel.wiki.git`), so the
pages live here, where they are reviewed with the code. `.github/workflows/wiki.yml` copies them
to the wiki whenever this folder changes on `main`. Run it by hand from the Actions tab with
**Publish wiki → Run workflow**.

- **First time only:** GitHub creates the wiki repository when the first page is saved in the web
  UI (Wiki → Create the first page). Do that once, then run the workflow.
- **File names are page titles:** `The-Flows.md` becomes "The Flows". `_Sidebar.md` is the menu.
- **Edit here, not in the wiki.** The workflow makes the wiki an exact copy of this folder, so a
  page edited only in the web UI is overwritten on the next sync.
- This README is not copied.
