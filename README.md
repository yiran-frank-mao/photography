# Shots
A tracker and ad free version of [rampatra/photography](https://github.com/rampatra/photography) with automations. You can set up [Zapier Workflow](https://zapier.com/shared/c6dc58c746bbe5c1fd42d86c9bda39e75ca6610b) which will connect to Instagram.

**Just follow the below steps and your website would be live in no time:**

1. Fork this repo by hitting the `Fork` button at the top right corner.
2. Enable github pages from the repo settings.
3. Upload your pictures to `images` directory. And a Github Action will add the photos where it needs to be.
4. Add your own custom domain in `CNAME` file or just remove the file if you don't own a domain and use the default domain that github provides ([yourusername].github.io/photography).
5. Update `baseurl` field in `_config.yml` file with whatever domain you used in step 4.
6. And that's it, your website is set. To view, go to [shots.pushpinderpalsingh.com/](https://shots.pushpinderpalsingh.com/) (or whatever you have in the CNAME file) and if you don't have one, you can go to [[yourusername].github.io/Shots](http://yourusername.github.io/Shots)

You can change my name in `_config.yml` file.

## Gallery layouts

Choose a layout in `_config.yml`, then rebuild the site:

```yaml
gallery_layout: Masonry
```

| Value | Layout |
| --- | --- |
| `Thumbnail` | The original responsive grid with cropped thumbnails (default). |
| `Masonry` | Equal-width columns; each uncropped photo goes into the shortest column. |
| `Justified` | Uncropped photos in equal-height rows that fill the gallery width. An incomplete last row stays at the target height. |
| `Carousel` | One uncropped photo at a time, with previous/next buttons, arrow keys when focused, and horizontal swipes. |

Names are case-insensitive. Missing or unrecognized values use `Thumbnail`.
Masonry and Justified display images from `image_fulls_loc` so their original
aspect ratios are preserved, even when the files in `image_thumbs_loc` are square.
Every layout keeps the existing click-to-expand viewer and EXIF information.
Carousel navigation stops at the first and last images, shows a position counter,
and adds navigation dots for galleries with 2–12 images.

The alternate layouts follow the layout behavior of
[Gallery View for Obsidian](https://github.com/mkshp-dev/obsidian-gallery-plugin).

To rebuild the committed CSS and JavaScript after editing their sources:

```sh
npm ci
npx gulp compile-sass
```

Run the browser regression checks with `npm test`. They use an installed
`/usr/bin/chromium`, a browser specified by `CHROMIUM_PATH`, or Playwright's
Chromium (install it with `npx playwright install chromium`). The tests render
the Liquid templates with fixture images and exercise the committed assets.

## Acknowledgment
- I am not a web developer. All the credit for this website goes to [Ram](https://github.com/rampatra).
