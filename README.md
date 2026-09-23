# jasonmcdowell.github.io · published site

This public repository is the GitHub Pages deployment assembly for [jasonmcdowell.github.io](https://jasonmcdowell.github.io/).

## What is published

- The root page is the personal project showcase.
- The Dream Home walkthrough is published at [`/home/`](https://jasonmcdowell.github.io/home/).

## Where the source lives

- The **Personal Webpage** project owns the root `index.html`, `site.css`, and showcase assets.
- The private **Dream Home** project owns the walkthrough source and its `/home/` build.
- This repository contains the public copies assembled for GitHub Pages. The personal project includes `publish-to-pages.sh` to copy its root files here without committing or pushing automatically.

## Adding another building

A contributor can fork this public repository, add a self-contained building folder such as `brother-house/`, and open a pull request. Review and merge the pull request to publish that building. Add a showcase tile in the Personal Webpage project when the building should appear on the root page.

Keep each individual file below GitHub's 100 MiB repository-file limit. Large models, textures, or videos should be compressed, split, or hosted elsewhere.
