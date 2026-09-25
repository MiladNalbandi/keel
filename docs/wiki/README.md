# Wiki source

These files are the source of the GitHub wiki. A wiki is a separate git repository
(`keel.wiki.git`), so this folder is published by copying it there:

```bash
git clone https://github.com/MiladNalbandi/keel.wiki.git
cp docs/wiki/*.md keel.wiki/ && rm keel.wiki/README.md
cd keel.wiki && git add -A && git commit -m "Update wiki" && git push
```

GitHub creates that repository only after the first page is saved in the web interface
(Wiki → Create the first page), so do that once before the first push.
File names map to page titles: `The-Flows.md` becomes "The Flows".
