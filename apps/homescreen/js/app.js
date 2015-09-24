/* global MozActivity, HomeMetadata, Datastore, Pages, LazyLoader, FirstRun */
/* jshint nonew: false */
'use strict';

/**
 * The distance a pinch gesture has to move before being considered for a
 * column-layout change.
 */
const PINCH_DISTANCE_THRESHOLD = 150;

/**
 * The minimum distance a pinch gesture has to move before being reflected
 * visually.
 */
const PINCH_FEEDBACK_THRESHOLD = 5;

/**
 * Timeout before resizing the apps grid after apps change.
 */
const RESIZE_TIMEOUT = 500;

/**
 * Timeout before showing a dialog. Without this, the click that comes through
 * after an activate event from gaia-container will close the dialog.
 */
const DIALOG_SHOW_TIMEOUT = 50;

/**
 * The distance at the top and bottom of the icon container that when hovering
 * an icon in will cause scrolling.
 */
const AUTOSCROLL_DISTANCE = 45;

/**
 * The timeout before auto-scrolling a page when hovering at the edges
 * of the grid.
 */
const AUTOSCROLL_DELAY = 750;

/**
 * The time to wait after setting a scroll-position before disabling
 * overflow during drag-and-drop.
 */
const AUTOSCROLL_OVERFLOW_DELAY = 500;

/**
 * The height of the delete-app bar at the bottom of the container when
 * dragging a deletable app.
 */
const DELETE_DISTANCE = 60;

/**
 * App roles that will be skipped on the homescreen.
 */
const HIDDEN_ROLES = [
  'system', 'input', 'homescreen', 'theme', 'addon', 'langpack'
];

/**
 * Strings that are matched against to black-list app origins.
 * TODO: This should not be hard-coded.
 */
const BLACKLIST = [
  'app://privacy-panel.gaiamobile.org'
];

/**
 * Stored settings version, for use when changing/refactoring settings storage.
 */
const SETTINGS_VERSION = 0;

(function(exports) {

  function App() {
    // Chrome is displayed
    window.performance.mark('navigationLoaded');

    // Element references
    this.indicator = document.getElementById('page-indicator');
    this.panels = document.getElementById('panels');
    this.meta = document.head.querySelector('meta[name="theme-color"]');
    this.shadow = document.querySelector('#apps-panel > .shadow');
    this.scrollable = document.querySelector('#apps-panel > .scrollable');
    this.icons = document.getElementById('apps');
    this.bottombar = document.getElementById('bottombar');
    this.uninstall = document.getElementById('uninstall');
    this.edit = document.getElementById('edit');
    this.cancelDownload = document.getElementById('cancel-download');
    this.resumeDownload = document.getElementById('resume-download');
    this.settingsDialog = document.getElementById('settings');
    this.dialogs =
      [this.cancelDownload, this.resumeDownload, this.settingsDialog];

    // XXX Working around gaia-components issue #8
    var dialog;
    for (dialog of this.dialogs) {
      dialog.hide();
    }

    // Change the colour of the statusbar when showing dialogs
    var dialogVisibilityCallback = () => {
      for (var dialog of this.dialogs) {
        if (dialog.opened) {
          this.meta.content = 'white';
          return;
        }
      }
      this.meta.content = 'transparent';
    };
    for (dialog of this.dialogs) {
      var observer = new MutationObserver(dialogVisibilityCallback);
      observer.observe(dialog,
        { attributes: true, attributeFilter: ['style'] });
    }

    // Paging
    this.resizeTimeout = null;
    this.pageHeight = 1;
    this.gridHeight = 1;
    this.pendingGridHeight = 1;

    // Scroll behaviour
    this.appsVisible = false;
    this.scrolled = false;

    // Pinch-to-zoom
    this.small = false;
    this.wasSmall = false;
    this.pinchListening = false;

    // Drag-and-drop
    this.dragging = false;
    this.draggingRemovable = false;
    this.draggingEditable = false;
    this.autoScrollTimeout = null;
    this.autoScrollOverflowTimeout = null;
    this.hoverIcon = null;

    // Update the panel indicator
    this.updatePanelIndicator();

    // Signal handlers
    document.body.addEventListener('contextmenu', this);
    this.panels.addEventListener('scroll', this);
    this.scrollable.addEventListener('scroll', this);
    this.icons.addEventListener('activate', this);
    this.icons.addEventListener('drag-start', this);
    this.icons.addEventListener('drag-move', this);
    this.icons.addEventListener('drag-end', this);
    this.icons.addEventListener('drag-rearrange', this);
    this.icons.addEventListener('drag-finish', this);
    this.icons.addEventListener('touchstart', this);
    this.icons.addEventListener('touchmove', this);
    this.icons.addEventListener('touchend', this);
    this.icons.addEventListener('touchcancel', this);
    navigator.mozApps.mgmt.addEventListener('install', this);
    navigator.mozApps.mgmt.addEventListener('uninstall', this);
    window.addEventListener('hashchange', this, true);
    window.addEventListener('localized', this);
    window.addEventListener('online', this);

    // Restore settings
    this.restoreSettings();

    // Populate apps callback
    var populateApps = () => {
      Promise.all([
        // Populate apps
        new Promise((resolve, reject) => {
          var request = navigator.mozApps.mgmt.getAll();
          request.onsuccess = (e) => {
            for (var app of request.result) {
              this.addApp(app);
            }
            resolve();

            // We've loaded and displayed all apps - only bookmarks and
            // pinned pages could be left (but they may also already be
            // loaded, as the sequence is asynchronous).
            window.performance.mark('visuallyLoaded');
            window.performance.mark('contentInteractive');
          };
          request.onerror = (e) => {
            console.error('Error calling getAll: ' + request.error.name);
            resolve();
          };
        }),

        // Initialise and populate bookmarks
        this.bookmarks.init().then(() => {
          document.addEventListener('bookmarks_store-set', (e) => {
            var id = e.detail.id;
            this.bookmarks.get(id).then((bookmark) => {
              for (var child of this.icons.children) {
                var icon = child.firstElementChild;
                if (icon.bookmark && icon.bookmark.id === id) {
                  icon.bookmark = bookmark.data;
                  icon.refresh();
                  return;
                }
              }
              this.bookmarks.get(id).then((bookmark) => {
                this.addAppIcon(bookmark.data);
                this.refreshGridSize();
              });
            });
          });

          document.addEventListener('bookmarks_store-removed', (e) => {
            var id = e.detail.id;
            for (var child of this.icons.children) {
              var icon = child.firstElementChild;
              if (icon.bookmark && icon.bookmark.id === id) {
                this.icons.removeChild(child, () => {
                  this.storeAppOrder();
                  this.refreshGridSize();
                  this.snapScrollPosition();
                });
                this.metadata.remove(id);
                return;
              }
            }
          });

          document.addEventListener('bookmarks_store-cleared', () => {
            for (var child of this.icons.children) {
              var icon = child.firstElementChild;
              if (icon.bookmark) {
                this.icons.removeChild(child);
              }
            }
            this.storeAppOrder();
            this.refreshGridSize();
            this.snapScrollPosition();
          });
        }, (e) => {
          console.error('Error initialising bookmarks', e);
        }).then(() => {
          return this.bookmarks.getAll().then((bookmarks) => {
            for (var bookmark of bookmarks) {
              this.addAppIcon(bookmark.data);
            }
          }, (e) => {
            console.error('Error getting bookmarks', e);
          });
        })
      ]).then(() => {
        if (!this.firstRun) {
          for (var data of this.startupMetadata) {
            console.log('Removing unknown app metadata entry', data.id);
            this.metadata.remove(data.id).then(
              () => {},
              (e) => {
                console.error('Error removing unknown app metadata entry', e);
              });
          }
        }
        this.startupMetadata = [];
        this.storeAppOrder();

        // All asynchronous loading has finished
        window.performance.mark('fullyLoaded');
      });
    };

    this.startupMetadata = [];
    this.iconsToRetry = [];
    this.metadata = new HomeMetadata();
    this.bookmarks = new Datastore('bookmarks_store');
    this.pages = new Pages();

    // Load metadata, then populate apps. If metadata loading fails,
    // populate apps anyway - it means they'll be in the default order
    // and their order won't save, but it's better than showing a blank
    // screen.
    // If this is the first run, get the app order from the first-run script
    // after initialising the metadata database.
    new Promise((resolve, reject) => {
      this.metadata.init().then(() => {
        if (this.firstRun) {
          resolve();
          return;
        }

        this.metadata.getAll().then((results) => {
          this.startupMetadata = results;
          resolve();
        },
        (e) => {
          console.error('Failed to retrieve metadata entries', e);
          resolve();
        });
      },
      (e) => {
        console.error('Failed to initialise metadata db', e);
        resolve();
      });
    }).then(this.firstRun ?
        LazyLoader.load(['js/firstrun.js'],
          () => {
            FirstRun().then((results) => {
              this.small = results.small;
              this.icons.classList.toggle('small', this.small);
              this.saveSettings();

              this.startupMetadata = results.order;
              populateApps();
            }, (e) => {
              console.error('Error running first-run script', e);
              populateApps();
            });
          },
          (e) => {
            console.error('Failed to load first-run script');
            populateApps();
          }) :
        populateApps);

    // Application has finished initialisation
    window.performance.mark('navigationInteractive');
  }

  App.prototype = {
    saveSettings: function() {
      localStorage.setItem('settings', JSON.stringify({
        version: SETTINGS_VERSION,
        small: this.small
      }));
    },

    restoreSettings: function() {
      var settingsString = localStorage.getItem('settings');
      if (!settingsString) {
        this.firstRun = true;
        return;
      }

      var settings = JSON.parse(settingsString);
      if (settings.version !== SETTINGS_VERSION) {
        return;
      }

      this.small = settings.small || false;
      this.icons.classList.toggle('small', this.small);
    },

    addApp: function(app) {
      var manifest = app.manifest || app.updateManifest;
      if (!manifest) {
        //console.log('Skipping app with no manifest', app);
        return;
      }

      // Do not add blacklisted apps
      if (BLACKLIST.includes(app.origin)) {
        return;
      }

      if (manifest.entry_points) {
        for (var entryPoint in manifest.entry_points) {
          this.addAppIcon(app, entryPoint);
        }
      } else {
        this.addAppIcon(app);
      }
    },

    addIconContainer: function(entry) {
      var container = document.createElement('div');
      container.classList.add('icon-container');
      container.order = -1;

      // Try to insert the container in the right order
      if (entry !== -1 && this.startupMetadata[entry].order >= 0) {
        container.order = this.startupMetadata[entry].order;
        var children = this.icons.children;
        for (var i = 0, iLen = children.length; i < iLen; i++) {
          var child = children[i];
          if (child.order !== -1 && child.order < container.order) {
            continue;
          }
          this.icons.insertBefore(container, child);
          break;
        }
      }

      if (!container.parentNode) {
        // If this is the first child we're adding, scroll-snapping wouldn't
        // have been initialised, so make sure to snap in this situation
        var callback = this.icons.firstChild ?
          () => { this.refreshGridSize(); } :
          () => { this.refreshGridSize(); this.snapScrollPosition(); };
        this.icons.appendChild(container, callback);
      }

      return container;
    },

    addAppIcon: function(appOrBookmark, entryPoint) {
      var id;
      if (appOrBookmark.manifestURL) {
        id = appOrBookmark.manifestURL + '/' + (entryPoint ? entryPoint : '');
      } else {
        id = appOrBookmark.id;
      }

      var entry = this.startupMetadata.findIndex((element) => {
        return element.id === id;
      });
      var container = this.addIconContainer(entry);

      var icon = document.createElement('gaia-app-icon');
      container.appendChild(icon);
      if (entryPoint) {
        icon.entryPoint = entryPoint;
      }

      if (appOrBookmark.manifestURL) {
        icon.app = appOrBookmark;

        // Hide/show the icon if the role changes to/from a hidden role
        var handleRoleChange = function(app, container) {
          var manifest = app.manifest || app.updateManifest;
          var hidden = (manifest && manifest.role &&
            HIDDEN_ROLES.includes(manifest.role));
          container.style.display = hidden ? 'none' : '';
        };

        icon.app.addEventListener('downloadapplied',
          function(app, container) {
            handleRoleChange(app, container);
            this.icons.synchronise();
          }.bind(this, icon.app, container));

        handleRoleChange(icon.app, container);
      } else {
        icon.bookmark = appOrBookmark;
      }

      // Load the cached icon
      if (entry !== -1) {
        icon.icon = this.startupMetadata[entry].icon;
        this.startupMetadata.splice(entry, 1);
      }

      // Save the refreshed icon
      this.iconsToRetry.push(id);
      icon.addEventListener('icon-loaded', function(icon, id) {
        icon.icon.then((blob) => {
          // Remove icon from list of icons to retry when we go online
          var retryIndex = this.iconsToRetry.indexOf(id);
          if (retryIndex !== -1) {
            this.iconsToRetry.splice(retryIndex, 1);
          }

          this.metadata.set([{ id: id, icon: blob }]).then(
            () => {},
            (e) => {
              console.error('Error saving icon', e);
            });
        });
      }.bind(this, icon, id));

      // Override default launch behaviour
      icon.addEventListener('activated', function(e) {
        e.preventDefault();
        this.handleEvent({ type: 'activate',
                           detail: { target: e.target.parentNode } });
      });

      // Refresh icon data (sets title and refreshes icon)
      icon.refresh();
    },

    storeAppOrder: function() {
      var storedOrders = [];
      var children = this.icons.children;
      for (var i = 0, iLen = children.length; i < iLen; i++) {
        var appIcon = children[i].firstElementChild;
        var id;
        if (appIcon.app) {
          id = appIcon.app.manifestURL + '/' + appIcon.entryPoint;
        } else {
          id = appIcon.bookmark.id;
        }
        storedOrders.push({ id: id, order: i });
      }
      this.metadata.set(storedOrders).then(
        () => {},
        (e) => {
          console.error('Error storing app order', e);
        });
    },

    stopPinch: function() {
      if (!this.pinchListening) {
        return;
      }

      this.scrollable.addEventListener('transitionend', this);
      this.pinchListening = false;
      this.scrollable.style.transition = '';
      this.scrollable.style.transform = '';
      this.handleEvent({ type: 'scroll' });
    },

    refreshGridSize: function() {
      var children = this.icons.children;

      var visibleChildren = 0;
      var firstVisibleChild = -1;
      for (var i = 0, iLen = children.length; i < iLen; i++) {
        if (children[i].style.display !== 'none') {
          visibleChildren ++;
          if (firstVisibleChild === -1) {
            firstVisibleChild = i;
          }
        }
      }

      if (visibleChildren < 1) {
        // Reset these to default values when all children have been removed
        this.pendingGridHeight = this.gridHeight = 0;
        this.pageHeight = this.scrollable.clientHeight;
      } else {
        var iconHeight = Math.round(children[firstVisibleChild].
          getBoundingClientRect().height);
        var scrollHeight = this.scrollable.clientHeight;
        var pageHeight = Math.floor(scrollHeight / iconHeight) * iconHeight;
        var gridHeight = (Math.ceil((iconHeight *
          Math.ceil(visibleChildren / (this.small ? 4 : 3))) / pageHeight) *
          pageHeight) + (scrollHeight - pageHeight);

        this.pageHeight = pageHeight;
        this.pendingGridHeight = gridHeight;
      }

      // Reset scroll-snap points
      this.scrollable.style.scrollSnapPointsY = `repeat(${this.pageHeight}px)`;

      // Set page border background
      this.icons.style.backgroundSize = '100% ' + (this.pageHeight * 2) + 'px';

      // Make sure the grid is a multiple of the page size. If the size has
      // shrunk we do this in a timeout so that the page scrolls has time
      // to scroll into place before we shrink the container.
      if (this.resizeTimeout !== null) {
        clearTimeout(this.resizeTimeout);
      }
      var setGridHeight = () => {
        this.resizeTimeout = null;
        this.icons.style.height = gridHeight + 'px';
        this.gridHeight = this.pendingGridHeight;
      };
      if (this.pendingGridHeight > this.gridHeight) {
        setGridHeight();
      } else if (this.pendingGridHeight !== this.gridHeight) {
        this.resizeTimeout = setTimeout(setGridHeight, RESIZE_TIMEOUT);
      }
    },

    snapScrollPosition: function(bias) {
      bias = bias || 0;
      var gridHeight = this.pendingGridHeight;
      var currentScroll = this.scrollable.scrollTop;
      var scrollHeight = this.scrollable.clientHeight;

      var destination = Math.min(gridHeight - scrollHeight,
        Math.round(currentScroll / this.pageHeight + bias) * this.pageHeight);

      if (Math.abs(destination - currentScroll) > 1) {
        this.scrollable.style.overflow = '';
        this.scrollable.scrollTo(
          { left: 0, top: destination, behavior: 'smooth' });

        if (this.autoScrollOverflowTimeout !== null) {
          clearTimeout(this.autoScrollOverflowTimeout);
          this.autoScrollOverflowTimeout = null;
        }

        if (this.dragging) {
          this.autoScrollOverflowTimeout = setTimeout(() => {
            this.autoScrollOverflowTimeout = null;
            this.scrollable.style.overflow = 'hidden';
            this.scrollable.scrollTop = destination;
          }, AUTOSCROLL_OVERFLOW_DELAY);
        }
      }
    },

    showActionDialog: function(dialog, args, callbacks) {
      // XXX Working around gaia-components issue #8.
      if (dialog.style.display !== 'none') {
        return;
      }

      function executeCallback(dialog, callback) {
        callback();
        dialog.close();
      }

      var actions = dialog.getElementsByClassName('action');
      for (var i = 0, iLen = Math.min(actions.length, callbacks.length);
           i < iLen; i++) {
        actions[i].onclick = executeCallback.bind(this, dialog, callbacks[i]);
      }
      if (args) {
        dialog.querySelector('.body').setAttribute('data-l10n-args', args);
      }
      setTimeout(() => { dialog.open(); }, DIALOG_SHOW_TIMEOUT);
    },

    updatePanelIndicator: function() {
      var appsVisible = this.panels.scrollLeft <= this.panels.scrollLeftMax / 2;
      if (this.appsVisible !== appsVisible) {
        this.appsVisible = appsVisible;
        this.indicator.children[0].classList.toggle('active', appsVisible);
        this.indicator.children[1].classList.toggle('active', !appsVisible);
        this.indicator.setAttribute('data-l10n-id', this.appsVisible ?
          'apps-panel' : 'pages-panel');
      }
    },

    handleEvent: function(e) {
      var icon, child, id;

      switch (e.type) {
      // Show the settings menu when the user long-presses and we aren't in
      // a drag
      case 'contextmenu':
        if (!document.body.classList.contains('dragging')) {
          this.showActionDialog(this.settingsDialog, null,
            [() => {
               new MozActivity({
                 name: 'configure',
                 data: {
                   target: 'device',
                   section: 'homescreen'
                 }
               });
             }]);
          e.stopImmediatePropagation();
          e.preventDefault();
        }
        break;

      // Display the top shadow when scrolling down
      case 'scroll':
        if (e.target === this.panels) {
          this.updatePanelIndicator();
          return;
        }

        var position = this.scrollable.scrollTop;
        var scrolled = position > 1;
        if (this.scrolled !== scrolled) {
          this.scrolled = scrolled;
          this.shadow.classList.toggle('visible', scrolled);
        }
        break;

      // App launching
      case 'activate':
        icon = e.detail.target.firstElementChild;

        switch (icon.state) {
          case 'unrecoverable':
            navigator.mozApps.mgmt.uninstall(icon.app);
            break;

          case 'installing':
            this.showActionDialog(this.cancelDownload,
              JSON.stringify({ name: icon.name }),
              [() => {
                 icon.app.cancelDownload();
               }]);
            break;

          case 'error':
          case 'paused':
            this.showActionDialog(this.resumeDownload,
              JSON.stringify({ name: icon.name }),
              [() => {
                 icon.app.download();
               }]);
            break;

          default:
            // Launching an app
            if (icon.app) {
              window.performance.mark('appLaunch@' + icon.app.origin);
            }

            icon.launch();
            break;
        }
        break;

      // Disable scrolling during dragging, and display bottom-bar
      case 'drag-start':
        this.dragging = true;
        document.body.classList.add('dragging');
        this.scrollable.style.overflow = 'hidden';
        icon = e.detail.target.firstElementChild;

        this.draggingEditable = !!icon.bookmark;
        this.draggingRemovable = this.draggingEditable || !!icon.app.removable;
        this.bottombar.classList.toggle('editable', this.draggingEditable);
        this.bottombar.classList.toggle('removable', this.draggingRemovable);
        if (this.draggingEditable || this.draggingRemovable) {
          this.bottombar.classList.add('active');
        }
        break;

      case 'drag-finish':
        this.dragging = false;
        document.body.classList.remove('dragging');
        this.scrollable.style.overflow = '';
        this.bottombar.classList.remove('active');
        this.edit.classList.remove('active');
        this.uninstall.classList.remove('active');

        if (this.autoScrollTimeout !== null) {
          clearTimeout(this.autoScrollTimeout);
          this.autoScrollTimeout = null;
        }

        if (this.autoScrollOverflowTimeout !== null) {
          clearTimeout(this.autoScrollOverflowTimeout);
          this.autoScrollOverflowTimeout = null;
        }

        if (this.hoverIcon) {
          this.hoverIcon.classList.remove('hover-before', 'hover-after');
          this.hoverIcon = null;
        }
        break;

      // Handle app/site uninstallation, editing and dragging to the end of
      // the icon grid.
      case 'drag-end':
        if ((!this.draggingRemovable && !this.draggingEditable) ||
            e.detail.clientY <= window.innerHeight - DELETE_DISTANCE) {
          // If the drop target is null, check to see if we're
          // dropping over the icon itself, and if we aren't, we must be
          // dropping over the end of the container.
          if (!e.detail.dropTarget) {
            var rect = this.icons.getChildOffsetRect(e.detail.target);
            var x = e.detail.clientX;
            var y = e.detail.clientY + this.scrollable.scrollTop;

            if (x < rect.left || y < rect.top ||
                x >= rect.right || y >= rect.bottom) {
              e.preventDefault();
              this.icons.reorderChild(e.detail.target, null,
                                      this.storeAppOrder.bind(this));
            }
          }
          return;
        }

        icon = e.detail.target.firstElementChild;

        if (icon.app && icon.app.removable) {
          e.preventDefault();
          navigator.mozApps.mgmt.uninstall(icon.app);
        } else if (icon.bookmark) {
          e.preventDefault();
          if (e.detail.clientX >= window.innerWidth / 2) {
            new MozActivity({
              name: 'save-bookmark',
              data: { type: 'url', url: icon.bookmark.id }
            });
          } else {
            new MozActivity({
              name: 'remove-bookmark',
              data: { type: 'url', url: icon.bookmark.id }
            });
          }
        }

        break;

      // Save the app grid after rearrangement
      case 'drag-rearrange':
        this.storeAppOrder();
        break;

      // Handle app-uninstall bar highlight and auto-scroll
      case 'drag-move':
        var inDelete = false;
        var inEdit = false;
        var inAutoscroll = false;

        if (this.draggingRemovable &&
            e.detail.clientY > window.innerHeight - DELETE_DISTANCE) {
          // User is dragging in the bottom toolbar (delete/edit) area
          if (this.draggingEditable &&
              e.detail.clientX >= window.innerWidth / 2) {
            inEdit = true;
          } else {
            inDelete = true;
          }
        } else if (e.detail.clientY >
                   window.innerHeight - DELETE_DISTANCE - AUTOSCROLL_DISTANCE) {
          // User is dragging in the lower auto-scroll area
          inAutoscroll = true;
          if (this.autoScrollTimeout === null) {
            this.autoScrollTimeout = setTimeout(() => {
              this.autoScrollTimeout = null;
              this.snapScrollPosition(1);
            }, AUTOSCROLL_DELAY);
          }
        } else if (e.detail.clientY < AUTOSCROLL_DISTANCE) {
          // User is dragging in the upper auto-scroll area
          inAutoscroll = true;
          if (this.autoScrollTimeout === null) {
            this.autoScrollTimeout = setTimeout(() => {
              this.autoScrollTimeout = null;
              this.snapScrollPosition(-1);
            }, AUTOSCROLL_DELAY);
          }
        } else {
          // User is dragging in the grid, provide some visual feedback
          var hoverIcon = this.icons.getChildFromPoint(e.detail.clientX,
                                                       e.detail.clientY);
          if (this.hoverIcon !== hoverIcon) {
            if (this.hoverIcon) {
              this.hoverIcon.classList.remove('hover-before', 'hover-after');
            }
            this.hoverIcon = (hoverIcon !== e.detail.target) ? hoverIcon : null;

            if (this.hoverIcon) {
              // XXX Note, we're taking advantage of gaia-container using
              //     Array instead of HTMLCollection here.
              var children = this.icons.children;
              var offset = children.indexOf(e.detail.target) -
                           children.indexOf(this.hoverIcon);

              this.hoverIcon.classList.add((offset >= 0) ?
                'hover-before' : 'hover-after');
            }
          }
        }

        if (!inAutoscroll && this.autoScrollTimeout !== null) {
          clearTimeout(this.autoScrollTimeout);
          this.autoScrollTimeout = null;
        }

        this.uninstall.classList.toggle('active', inDelete);
        this.edit.classList.toggle('active', inEdit);
        break;

      // Pinch-to-zoom
      case 'touchstart':
        if (e.touches.length === 2) {
          this.wasSmall = this.small;
          this.startDistance =
            Math.sqrt(Math.pow(e.touches[0].clientX -
                               e.touches[1].clientX, 2) +
                      Math.pow(e.touches[0].clientY -
                               e.touches[1].clientY, 2));
          this.pinchListening = true;
          document.body.classList.add('zooming');
          this.scrollable.style.transition = 'unset';
        } else {
          this.stopPinch();
        }
        break;

      case 'touchmove':
        if (!this.pinchListening || e.touches.length !== 2) {
          return;
        }

        var distance =
          (Math.sqrt(Math.pow(e.touches[0].clientX -
                              e.touches[1].clientX, 2) +
                     Math.pow(e.touches[0].clientY -
                              e.touches[1].clientY, 2))) -
          this.startDistance;

        var newState;
        if (this.wasSmall) {
          newState = (distance < PINCH_DISTANCE_THRESHOLD);
        } else {
          newState = (distance < -PINCH_DISTANCE_THRESHOLD);
        }

        if (!this.scrolled && distance > 0) {
          this.scrolled = true;
          this.shadow.classList.add('visible');
        }

        if (this.small !== newState) {
          this.small = newState;
          this.icons.style.height = '';
          this.icons.classList.toggle('small', this.small);
          this.icons.synchronise();
          this.stopPinch();
          this.saveSettings();
        } else if (Math.abs(distance) > PINCH_FEEDBACK_THRESHOLD) {
          this.scrollable.style.transform = 'scale(' +
            ((window.innerWidth + distance / 4) / window.innerWidth) + ')';
        }
        break;

      case 'touchend':
      case 'touchcancel':
        if (!e.touches || e.touches.length === 0) {
          this.handleEvent({ type: 'scroll' });
        }

        this.stopPinch();
        break;

      case 'transitionend':
        if (e.target === this.scrollable) {
          this.scrollable.removeEventListener('transitionend', this);
          document.body.classList.remove('zooming');
          this.refreshGridSize();
          this.snapScrollPosition();
        }
        break;

      // Add apps installed after startup
      case 'install':
        this.addApp(e.application);
        break;

      // Remove apps uninstalled after startup
      case 'uninstall':
        var callback = () => {
          this.storeAppOrder();
          this.refreshGridSize();
          this.snapScrollPosition();
        };

        for (child of this.icons.children) {
          icon = child.firstElementChild;
          if (icon.app && icon.app.manifestURL === e.application.manifestURL) {
            id = e.application.manifestURL + '/' +
              (icon.entryPoint ? icon.entryPoint : '');
            this.metadata.remove(id).then(() => {},
              (e) => {
                console.error('Error removing uninstalled app', e);
              });

            this.icons.removeChild(child, callback);

            // We only want to store the app order once, so clear the callback
            callback = null;
          }
        }
        break;

      case 'hashchange':
        if (!document.hidden) {
          // If a dialog is showing, cancel the dialog
          for (var dialog of this.dialogs) {
            if (!dialog.opened) {
              continue;
            }

            dialog.close();
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }

          if (this.panels.scrollLeft ===
              this.scrollable.parentNode.offsetLeft) {
            this.scrollable.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
          }
        }
        break;

      case 'localized':
        for (icon of this.icons.children) {
          icon.firstElementChild.updateName();
        }
        this.icons.synchronise();
        this.updatePanelIndicator();
        break;

      case 'online':
        for (var i = 0, iLen = this.iconsToRetry.length; i < iLen; i++) {
          for (child of this.icons.children) {
            icon = child.firstElementChild;
            id = icon.app ?
              (icon.app.manifestURL + '/' +
               (icon.entryPoint ? icon.entryPoint : '')) : icon.bookmark.id;
            if (id === this.iconsToRetry[i]) {
              icon.refresh();
              break;
            }
          }
        }
        break;
      }
    }
  };

  exports.App = App;

}(window));
