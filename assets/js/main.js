/*
 Multiverse by HTML5 UP
 html5up.net | @ajlkn
 Free for personal and commercial use under the CCA 3.0 license (html5up.net/license)

 Added EXIF data and enhanced for Jekyll by Ram Patra
 */

(function ($) {

    skel.breakpoints({
        xlarge: '(max-width: 1680px)',
        large: '(max-width: 1280px)',
        medium: '(max-width: 980px)',
        small: '(max-width: 736px)',
        xsmall: '(max-width: 480px)'
    });

    $(function () {

        var $window = $(window),
            $body = $('body'),
            $wrapper = $('#wrapper');

        // Hack: Enable IE workarounds.
        if (skel.vars.IEVersion < 12)
            $body.addClass('ie');

        // Touch?
        if (skel.vars.mobile)
            $body.addClass('touch');

        // Transitions supported?
        if (skel.canUse('transition')) {

            // Add (and later, on load, remove) "loading" class.
            $body.addClass('loading');

            $window.on('load', function () {
                window.setTimeout(function () {
                    $body.removeClass('loading');
                }, 100);
            });

            // Prevent transitions/animations on resize.
            var resizeTimeout;

            $window.on('resize', function () {

                window.clearTimeout(resizeTimeout);

                $body.addClass('resizing');

                resizeTimeout = window.setTimeout(function () {
                    $body.removeClass('resizing');
                }, 100);

            });

        }

        // Scroll back to top.
        $window.scrollTop(0);

        // Fix: Placeholder polyfill.
        $('form').placeholder();

        // Panels.
        var $panels = $('.panel');

        $panels.each(function () {

            var $this = $(this),
                $toggles = $('[href="#' + $this.attr('id') + '"]'),
                $closer = $('<div class="closer" />').appendTo($this);

            // Closer.
            $closer
                .on('click', function (event) {
                    $this.trigger('---hide');
                });

            // Events.
            $this
                .on('click', function (event) {
                    event.stopPropagation();
                })
                .on('---toggle', function () {

                    if ($this.hasClass('active'))
                        $this.triggerHandler('---hide');
                    else
                        $this.triggerHandler('---show');

                })
                .on('---show', function () {

                    // Hide other content.
                    if ($body.hasClass('content-active'))
                        $panels.trigger('---hide');

                    // Activate content, toggles.
                    $this.addClass('active');
                    $toggles.addClass('active');

                    // Activate body.
                    $body.addClass('content-active');

                })
                .on('---hide', function () {

                    // Deactivate content, toggles.
                    $this.removeClass('active');
                    $toggles.removeClass('active');

                    // Deactivate body.
                    $body.removeClass('content-active');

                });

            // Toggles.
            $toggles
                .removeAttr('href')
                .css('cursor', 'pointer')
                .on('click', function (event) {

                    event.preventDefault();
                    event.stopPropagation();

                    $this.trigger('---toggle');

                });

        });

        // Global events.
        $body
            .on('click', function (event) {

                if ($body.hasClass('content-active')) {

                    event.preventDefault();
                    event.stopPropagation();

                    $panels.trigger('---hide');

                }

            });

        $window
            .on('keyup', function (event) {

                if (event.keyCode == 27
                    && $body.hasClass('content-active')) {

                    event.preventDefault();
                    event.stopPropagation();

                    $panels.trigger('---hide');

                }

            });

        // Header.
        var $header = $('#header');

        // Links.
        $header.find('a').each(function () {

            var $this = $(this),
                href = $this.attr('href');

            // Internal link? Skip.
            if (!href
                || href.charAt(0) == '#')
                return;

            // Redirect on click.
            $this
                .removeAttr('href')
                .css('cursor', 'pointer')
                .on('click', function (event) {

                    event.preventDefault();
                    event.stopPropagation();

                    window.location.href = href;

                });

        });

        // Footer.
        var $footer = $('#footer');

        // Copyright.
        // This basically just moves the copyright line to the end of the *last* sibling of its current parent
        // when the "medium" breakpoint activates, and moves it back when it deactivates.
        $footer.find('.copyright').each(function () {

            var $this = $(this),
                $parent = $this.parent(),
                $lastParent = $parent.parent().children().last();

            skel
                .on('+medium', function () {
                    $this.appendTo($lastParent);
                })
                .on('-medium', function () {
                    $this.appendTo($parent);
                });

        });

        // Main.
        var $main = $('#main'),
            galleryLayout = $main.attr('data-layout') || 'thumbnail',
            exifDatas = {};

        // Thumbs.
        $main.children('.thumb').each(function () {

            var $this = $(this),
                $image = $this.find('.image'), $image_img = $image.children('img'),
                x;

            // No image? Bail.
            if ($image.length == 0)
                return;

            // Image.
            // This sets the background of the "image" <span> to the image pointed to by its child
            // <img> (which is then hidden). Gives us way more flexibility.

            if (galleryLayout === 'thumbnail') {
                // Preserve the original cropped thumbnail layout.
                $image.css('background-image', 'url(' + $image_img.attr('src') + ')');

                if (x = $image_img.data('position'))
                    $image.css('background-position', x);

                $image_img.hide();
            }

            // Hack: IE<11 doesn't support pointer-events, which means clicks to our image never
            // land as they're blocked by the thumbnail's caption overlay gradient. This just forces
            // the click through to the image.
            if (skel.vars.IEVersion < 11)
                $this
                    .css('cursor', 'pointer')
                    .on('click', function () {
                        $image.trigger('click');
                    });

            // EXIF data					
            EXIF.getData($image_img[0], function () {
                exifDatas[$image_img.data('name')] = getExifDataMarkup(this);
            });

        });

        initializeGallery();

        // Poptrox.
        $main.poptrox({
            baseZIndex: 20000,
            caption: function ($a) {
                var $image_img = $a.children('img');
                var data = exifDatas[$image_img.data('name')];
                if (data === undefined) {
                    // EXIF data					
                    EXIF.getData($image_img[0], function () {
                        data = exifDatas[$image_img.data('name')] = getExifDataMarkup(this);
                    });
                }
                return data !== undefined ? '<p>' + data + '</p>' : ' ';
            },
            fadeSpeed: 300,
            onPopupClose: function () {
                $body.removeClass('modal-active');
            },
            onPopupOpen: function () {
                $body.addClass('modal-active');
            },
            overlayOpacity: 0,
            popupCloserText: '',
            popupHeight: 150,
            popupLoaderText: '',
            popupSpeed: 300,
            popupWidth: 150,
            selector: '.thumb > a.image',
            usePopupCaption: true,
            usePopupCloser: true,
            usePopupDefaultStyling: false,
            usePopupForceClose: true,
            usePopupLoader: true,
            usePopupNav: true,
            windowMargin: 50
        });

        // Hack: Set margins to 0 when 'xsmall' activates.
        skel
            .on('-xsmall', function () {
                $main[0]._poptrox.windowMargin = 50;
            })
            .on('+xsmall', function () {
                $main[0]._poptrox.windowMargin = 0;
            });

        function initializeGallery() {
            if (galleryLayout === 'thumbnail') return;

            var $tiles = $main.children('.thumb');
            $main.addClass('gallery-ready');

            if (galleryLayout === 'carousel') {
                initializeCarousel($tiles);
                return;
            }

            var pending = false,
                previousWidth = 0;

            function scheduleLayout() {
                if (pending) return;
                pending = true;
                window.requestAnimationFrame(function () {
                    pending = false;
                    var width = $main.width();
                    if (!width) return;
                    previousWidth = width;
                    layoutTiles($tiles, width);
                });
            }

            // Cached, late, and failed images all receive usable geometry.
            $tiles.find('img').on('load error', scheduleLayout);
            $window.on('resize', scheduleLayout);
            if (window.ResizeObserver) {
                var observer = new ResizeObserver(function () {
                    if ($main.width() !== previousWidth) scheduleLayout();
                });
                observer.observe($main[0]);
            }
            scheduleLayout();
        }

        function layoutTiles($tiles, width) {
            var tiles = $tiles.map(function () {
                var img = $(this).find('img')[0];
                return { element: this, ratio: img.naturalWidth / img.naturalHeight || 1.5 };
            }).get();

            function place(tile, left, top, tileWidth, height) {
                $(tile.element).css({ left: left, top: top, width: tileWidth, height: height });
            }

            if (galleryLayout === 'masonry') {
                var gap = 8,
                    columns = Math.max(1, Math.floor((width + gap) / (220 + gap))),
                    columnWidth = (width - gap * (columns - 1)) / columns,
                    heights = [];
                for (var c = 0; c < columns; c++) heights.push(0);
                tiles.forEach(function (tile) {
                    var shortest = heights.indexOf(Math.min.apply(Math, heights)),
                        height = columnWidth / tile.ratio;
                    place(tile, shortest * (columnWidth + gap), heights[shortest], columnWidth, height);
                    heights[shortest] += height + gap;
                });
                $main.height(Math.max(0, Math.max.apply(Math, heights) - gap));
                return;
            }

            var rowGap = 4,
                targetHeight = Math.min(220, width * 0.4),
                row = [],
                ratioSum = 0,
                top = 0;

            function rowHeight(count, sum) {
                return (width - rowGap * (count - 1)) / sum;
            }

            function finishRow(height) {
                var left = 0;
                row.forEach(function (tile) {
                    var tileWidth = tile.ratio * height;
                    place(tile, left, top, tileWidth, height);
                    left += tileWidth + rowGap;
                });
                top += height + rowGap;
                row = [];
                ratioSum = 0;
            }

            tiles.forEach(function (tile) {
                // A panorama gets its own row without stretching the preceding row.
                if (tile.ratio * targetHeight >= width) {
                    if (row.length) finishRow(Math.min(targetHeight, rowHeight(row.length, ratioSum)));
                    row = [tile];
                    finishRow(width / tile.ratio);
                    return;
                }
                var withTile = rowHeight(row.length + 1, ratioSum + tile.ratio);
                if (row.length && withTile < targetHeight) {
                    var withoutTile = rowHeight(row.length, ratioSum);
                    if (withoutTile - targetHeight <= targetHeight - withTile) {
                        finishRow(withoutTile);
                    } else {
                        row.push(tile);
                        finishRow(withTile);
                        return;
                    }
                }
                row.push(tile);
                ratioSum += tile.ratio;
            });
            // Keep an incomplete last row at the target height.
            if (row.length) finishRow(Math.min(targetHeight, rowHeight(row.length, ratioSum)));
            $main.height(Math.max(0, top - rowGap));
        }

        function initializeCarousel($tiles) {
            var count = $tiles.length;
            if (!count) return;

            var $viewport = $('<div class="carousel-viewport" />').appendTo($main),
                $track = $('<div class="carousel-track" />').append($tiles).appendTo($viewport),
                index = 0,
                $previous, $next, $counter,
                $dots = $();

            $main.attr({ tabindex: '0', role: 'region', 'aria-roledescription': 'carousel', 'aria-label': 'Photo gallery' });
            $tiles.each(function (i) {
                $(this).attr({ role: 'group', 'aria-roledescription': 'slide', 'aria-label': (i + 1) + ' / ' + count });
            });

            function goTo(nextIndex) {
                index = Math.max(0, Math.min(count - 1, nextIndex));
                $track.css('transform', 'translateX(-' + index * 100 + '%)');
                $tiles.each(function (i) {
                    $(this).attr('aria-hidden', i !== index ? 'true' : 'false')
                        .find('a').attr('tabindex', i === index ? '0' : '-1');
                });
                if ($previous) {
                    $previous.prop('disabled', index === 0);
                    $next.prop('disabled', index === count - 1);
                    $counter.text((index + 1) + ' / ' + count);
                    $dots.each(function (i) {
                        $(this).attr('aria-current', i === index ? 'true' : null);
                    });
                }
            }

            if (count > 1) {
                $previous = $('<button type="button" class="carousel-nav previous" aria-label="Previous image">&#10094;</button>').appendTo($viewport);
                $next = $('<button type="button" class="carousel-nav next" aria-label="Next image">&#10095;</button>').appendTo($viewport);
                $counter = $('<div class="carousel-counter" aria-live="polite" aria-atomic="true" />').appendTo($viewport);
                $previous.on('click', function () { goTo(index - 1); });
                $next.on('click', function () { goTo(index + 1); });
                if (count <= 12) {
                    var $indicators = $('<div class="carousel-indicators" />').appendTo($main);
                    $tiles.each(function (i) {
                        $('<button type="button" class="carousel-dot" />')
                            .attr('aria-label', 'Go to image ' + (i + 1))
                            .on('click', function () { goTo(i); }).appendTo($indicators);
                    });
                    $dots = $indicators.children();
                }
            }

            $main.on('keydown', function (event) {
                if ($body.hasClass('modal-active') || $body.hasClass('content-active')) return;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    event.stopPropagation();
                    goTo(index + (event.key === 'ArrowLeft' ? -1 : 1));
                }
            });

            var touchStart = null,
                swiped = false;
            $viewport.on('touchstart', function (event) {
                var touches = event.originalEvent.touches;
                touchStart = touches.length === 1 ? { x: touches[0].clientX, y: touches[0].clientY } : null;
                swiped = false;
            }).on('touchend', function (event) {
                if (!touchStart) return;
                var touch = event.originalEvent.changedTouches[0],
                    dx = touch.clientX - touchStart.x,
                    dy = touch.clientY - touchStart.y;
                if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy)) {
                    goTo(index + (dx < 0 ? 1 : -1));
                    swiped = true;
                    window.setTimeout(function () { swiped = false; }, 350);
                }
                touchStart = null;
            }).on('touchcancel', function () { touchStart = null; });
            // Do not open the lightbox from the synthetic click following a swipe.
            $viewport[0].addEventListener('click', function (event) {
                if (swiped) {
                    event.preventDefault();
                    event.stopPropagation();
                    swiped = false;
                }
            }, true);

            goTo(0);
        }

        function getExifDataMarkup(img) {
            var exif = fetchExifData(img);
            var template = '';
            for (var info in exif) {
                if (info === "model") {
                    template += '<i class="fa fa-camera-retro" aria-hidden="true"></i> ' + exif["model"] + '&nbsp;&nbsp;';
                }
                if (info === "aperture") {
                    template += '<i class="fa fa-dot-circle-o" aria-hidden="true"></i> f/' + exif["aperture"] + '&nbsp;&nbsp;';
                }
                if (info === "shutter_speed") {
                    template += '<i class="fa fa-clock-o" aria-hidden="true"></i> ' + exif["shutter_speed"] + '&nbsp;&nbsp;';
                }
                if (info === "iso") {
                    template += '<i class="fa fa-info-circle" aria-hidden="true"></i> ' + exif["iso"] + '&nbsp;&nbsp;';
                }
            }
            return template;
        }

        function fetchExifData(img) {
            var exifData = {};

            if (EXIF.getTag(img, "Model") !== undefined) {
                exifData.model = EXIF.getTag(img, "Model");
            }

            if (EXIF.getTag(img, "FNumber") !== undefined) {
                exifData.aperture = EXIF.getTag(img, "FNumber");
            }

            if (EXIF.getTag(img, "ExposureTime") !== undefined) {
                exifData.shutter_speed = EXIF.getTag(img, "ExposureTime");
            }

            if (EXIF.getTag(img, "ISOSpeedRatings") !== undefined) {
                exifData.iso = EXIF.getTag(img, "ISOSpeedRatings");
            }
            return exifData;
        }

    });

})(jQuery);
