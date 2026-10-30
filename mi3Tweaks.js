// mi3Tweaks: a Spicetify extension bundle. Spicetify loads a single file per
// extension, so every feature lives here.
//
// To add a feature, write a `create<Name>Feature(Util)` factory that returns
// `{ id, title, buildSettingsSection() }` and add it to `features` below.

(function mi3Tweaks() {
    mi3Tweaks.waitStart ??= Date.now();
    const missing =
        typeof Spicetify === "undefined"
            ? ["Spicetify"]
            : ["Player", "Menu", "ContextMenu", "PopupModal", "Keyboard"].filter((k) => !Spicetify[k]);
    if (missing.length) {
        if (Date.now() - mi3Tweaks.waitStart > 10000 && !mi3Tweaks.warned) {
            mi3Tweaks.warned = true;
            console.warn("[mi3Tweaks] Waiting for APIs not yet ready:", missing.join(", "));
        }
        setTimeout(mi3Tweaks, 300);
        return;
    }

    // =======================================================================
    // Shared utilities
    // =======================================================================
    const Util = {};

    Util.matchesAny = function (patterns, value) {
        if (!value) return false;
        return patterns.some((pattern) => pattern.test(value));
    };

    // Context menu items from every feature go into one "mi3Tweaks" submenu.
    // Don't .register() them individually - only the submenu is registered.
    Util.contextMenuItems = [];

    // Item wraps the shouldAdd it's given, so keep the raw callbacks to decide
    // whether the submenu itself should show.
    Util.contextMenuShouldAdds = [];

    Util.addContextMenuItem = function (name, onClick, shouldAdd, icon) {
        const item = new Spicetify.ContextMenu.Item(name, onClick, shouldAdd, icon);
        Util.contextMenuItems.push(item);
        Util.contextMenuShouldAdds.push(shouldAdd || (() => true));
        return item;
    };

    Util.entryUri = function (entry) {
        return typeof entry === "string" ? entry : entry?.uri;
    };

    // Namespaced so keys can't collide with other extensions.
    Util.storageKey = function (key) {
        return `mi3Tweaks:${key}`;
    };

    // A localStorage array of {uri, name, artist}, or a plain uri string when
    // the metadata lookup failed.
    Util.createTrackList = function (storageKey) {
        function load() {
            try {
                const raw = localStorage.getItem(storageKey);
                const parsed = raw ? JSON.parse(raw) : [];
                // Drop malformed entries so every entry has a uri.
                return Array.isArray(parsed) ? parsed.filter((entry) => Util.entryUri(entry)) : [];
            } catch (e) {
                return [];
            }
        }

        function save(list) {
            localStorage.setItem(storageKey, JSON.stringify(list));
        }

        function has(uri) {
            if (!uri) return false;
            return load().some((entry) => Util.entryUri(entry) === uri);
        }

        function add(uri, meta) {
            if (!uri) return;
            const list = load();
            if (list.some((entry) => Util.entryUri(entry) === uri)) return;
            list.push(meta ? { uri, name: meta.name || null, artist: meta.artist || null } : uri);
            save(list);
        }

        function remove(uri) {
            if (!uri) return;
            save(load().filter((entry) => Util.entryUri(entry) !== uri));
        }

        // No-op if the entry was removed.
        function setMeta(uri, meta) {
            if (!uri || !meta) return;
            save(
                load().map((entry) =>
                    Util.entryUri(entry) === uri ? { uri, name: meta.name || null, artist: meta.artist || null } : entry
                )
            );
        }

        return { load, has, add, remove, setMeta };
    };

    Util.getAccessToken = function () {
        try {
            const token = Spicetify.Platform?.AuthorizationAPI?.getState?.()?.token?.accessToken;
            if (token) return token;
        } catch (e) {}
        return null;
    };

    // Tries each source in order until one returns a name.
    Util.fetchTrackMeta = async function (uri) {
        // The playing track's metadata is already loaded locally.
        const current = Spicetify.Player.data?.item;
        if (current && current.uri === uri) {
            return {
                name: current.name || current.metadata?.title || null,
                artist:
                    (current.artists || []).map((a) => a.name).join(", ") ||
                    current.metadata?.artist_name ||
                    null,
            };
        }

        // The client's own GraphQL query. Unlike the Web API below, it isn't
        // rate-limited (429) for this use.
        const getTrack = Spicetify.GraphQL?.Definitions?.getTrack;
        if (getTrack) {
            try {
                const res = await Spicetify.GraphQL.Request(getTrack, { uri });
                const track = res?.data?.trackUnion;
                if (!track?.name) throw new Error("getTrack response had no name");
                const artists = [...(track.firstArtist?.items || []), ...(track.otherArtists?.items || [])]
                    .map((a) => a?.profile?.name)
                    .filter(Boolean);
                return { name: track.name, artist: artists.join(", ") || null };
            } catch (e) {
                console.warn("[mi3Tweaks] fetchTrackMeta via GraphQL getTrack failed for", uri, e);
            }
        }

        const id = uri.split(":")[2];

        const token = Util.getAccessToken();
        if (token) {
            try {
                const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!res.ok) throw new Error(`Spotify API error: ${res.status}`);
                const data = await res.json();
                return {
                    name: data?.name || null,
                    artist: (data?.artists || []).map((a) => a.name).join(", ") || null,
                };
            } catch (e) {
                console.error("[mi3Tweaks] fetchTrackMeta via fetch()+token failed for", uri, e);
            }
        } else {
            console.warn(
                "[mi3Tweaks] fetchTrackMeta: no access token from Spicetify.Platform.AuthorizationAPI, trying CosmosAsync instead."
            );
        }

        // Fails with "Resolver not found!" on some client builds.
        try {
            const res = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${id}`);
            return {
                name: res?.name || null,
                artist: (res?.artists || []).map((a) => a.name).join(", ") || null,
            };
        } catch (e) {
            console.error("[mi3Tweaks] fetchTrackMeta via CosmosAsync also failed for", uri, e);
        }

        // Public oEmbed endpoint: no auth, but returns the title only.
        try {
            const trackUrl = `https://open.spotify.com/track/${id}`;
            const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`);
            if (!res.ok) throw new Error(`oEmbed error: ${res.status}`);
            const data = await res.json();
            if (!data?.title) throw new Error("oEmbed response had no title");
            return { name: data.title, artist: null };
        } catch (e) {
            console.error("[mi3Tweaks] fetchTrackMeta via oEmbed also failed for", uri, e);
            return null;
        }
    };

    Util.injectStylesOnce = function () {
        if (document.getElementById("mi3tweaks-style")) return;
        const style = document.createElement("style");
        style.id = "mi3tweaks-style";
        style.textContent = `
            .mi3tweaks-settings { padding: 4px 2px; max-width: 420px; }
            .mi3tweaks-feature-heading { font-size: 17px; margin: 0 0 8px; font-weight: 700; }
            .mi3tweaks-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; cursor: pointer; font-size: 14px; }
            .mi3tweaks-row input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: #1ed760; }
            .mi3tweaks-divider { border: none; border-top: 1px solid rgba(255,255,255,0.15); margin: 12px 0; }
            .mi3tweaks-divider-feature { border-top: 1px solid rgba(255,255,255,0.3); margin: 20px 0; }
            .mi3tweaks-subheading { font-size: 15px; margin: 0 0 4px; font-weight: 700; }
            .mi3tweaks-empty { font-size: 13px; opacity: 0.6; padding: 8px 0; }
            .mi3tweaks-list { max-height: 200px; overflow-y: auto; }
            .mi3tweaks-list-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.08); }
            .mi3tweaks-list-info { display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
            .mi3tweaks-list-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .mi3tweaks-list-artist { font-size: 11px; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .mi3tweaks-remove-btn { flex-shrink: 0; background: rgba(255,255,255,0.1); border: none; border-radius: 4px; color: #fff; padding: 4px 10px; font-size: 12px; cursor: pointer; }
            .mi3tweaks-remove-btn:hover { background: rgba(255,255,255,0.2); }
            .mi3tweaks-hint { font-size: 12px; opacity: 0.7; margin: 0 0 10px; }
            .mi3tweaks-input-row { padding: 8px 0; }
            .mi3tweaks-input-label { display: block; font-size: 13px; margin-bottom: 6px; }
            .mi3tweaks-input-wrap { display: flex; gap: 8px; }
            .mi3tweaks-input { flex: 1; min-width: 0; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: #fff; padding: 6px 8px; font-size: 13px; }
            .mi3tweaks-input:focus { outline: none; border-color: #1ed760; }
            .mi3tweaks-save-btn { flex-shrink: 0; background: #1ed760; border: none; border-radius: 4px; color: #000; padding: 6px 14px; font-size: 12px; font-weight: 700; cursor: pointer; }
            .mi3tweaks-save-btn:hover { background: #3be477; }
        `;
        document.head.appendChild(style);
    };

    Util.buildToggleRow = function (labelText, checked, onChange) {
        const row = document.createElement("label");
        row.className = "mi3tweaks-row";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = checked;
        checkbox.addEventListener("change", () => onChange(checkbox.checked));

        const span = document.createElement("span");
        span.textContent = labelText;

        row.appendChild(checkbox);
        row.appendChild(span);
        return row;
    };

    // Removing an entry deletes just its row, so the modal keeps its scroll
    // position.
    Util.buildListSection = function (list, onRemove) {
        const container = document.createElement("div");
        container.className = "mi3tweaks-list";

        function appendEmptyMessage() {
            const empty = document.createElement("p");
            empty.className = "mi3tweaks-empty";
            empty.textContent = "登録されている曲はありません";
            container.appendChild(empty);
        }

        const entries = list.load();
        if (entries.length === 0) {
            appendEmptyMessage();
            return container;
        }

        // Entries saved without a name show the raw URI; retry their lookup.
        const missingNames = [];

        entries.forEach((entry) => {
            const uri = Util.entryUri(entry);
            const name = typeof entry === "object" ? entry.name : null;
            const artist = typeof entry === "object" ? entry.artist : null;

            const row = document.createElement("div");
            row.className = "mi3tweaks-list-row";

            const info = document.createElement("div");
            info.className = "mi3tweaks-list-info";

            function renderInfo(name, artist) {
                info.textContent = "";

                const nameEl = document.createElement("span");
                nameEl.className = "mi3tweaks-list-name";
                nameEl.textContent = name || uri;
                info.appendChild(nameEl);

                if (artist) {
                    const artistEl = document.createElement("span");
                    artistEl.className = "mi3tweaks-list-artist";
                    artistEl.textContent = artist;
                    info.appendChild(artistEl);
                }
            }

            renderInfo(name, artist);
            if (!name) missingNames.push({ uri, renderInfo });

            row.appendChild(info);

            const removeBtn = document.createElement("button");
            removeBtn.className = "mi3tweaks-remove-btn";
            removeBtn.textContent = "削除";
            removeBtn.addEventListener("click", (event) => {
                // Removing the row detaches this button, so PopupModal would
                // treat the click as an outside click and close.
                event.stopPropagation();
                onRemove(uri);
                row.remove();
                if (!container.querySelector(".mi3tweaks-list-row")) appendEmptyMessage();
            });
            row.appendChild(removeBtn);

            container.appendChild(row);
        });

        // One at a time, to go easy on rate limits.
        (async () => {
            for (const { uri, renderInfo } of missingNames) {
                const meta = await Util.fetchTrackMeta(uri);
                if (!meta?.name || !list.has(uri)) continue;
                list.setMeta(uri, meta);
                renderInfo(meta.name, meta.artist);
            }
        })();

        return container;
    };

    Util.buildTextInputRow = function (labelText, value, placeholder, onSave) {
        const row = document.createElement("div");
        row.className = "mi3tweaks-input-row";

        const label = document.createElement("label");
        label.className = "mi3tweaks-input-label";
        label.textContent = labelText;
        row.appendChild(label);

        const wrap = document.createElement("div");
        wrap.className = "mi3tweaks-input-wrap";

        const input = document.createElement("input");
        input.type = "password";
        input.className = "mi3tweaks-input";
        input.value = value || "";
        input.placeholder = placeholder || "";
        wrap.appendChild(input);

        const saveBtn = document.createElement("button");
        saveBtn.className = "mi3tweaks-save-btn";
        saveBtn.textContent = "保存";
        saveBtn.addEventListener("click", () => {
            onSave(input.value.trim());
            Spicetify.showNotification("保存しました");
        });
        wrap.appendChild(saveBtn);

        row.appendChild(wrap);
        return row;
    };

    // =======================================================================
    // Feature: Cover Skip
    // =======================================================================
    function createCoverSkipFeature(Util) {
        const STORAGE_KEY = Util.storageKey("coverSkip:enabled");
        const STRICT_STORAGE_KEY = Util.storageKey("coverSkip:strict"); // artist/album name heuristics

        // No bare /\bcover\b/: it matches originals like "Cover Me". "cover"
        // only counts inside brackets or after a dash.
        const TITLE_PATTERNS = [
            /[\(\[（【][^\)\]）】]*\bcover\b[^\)\]）】]*[\)\]）】]/i, // (Cover), [Piano Cover], 【Cover by X】
            /-\s*cover\s*-/i,
            /-\s*(?:\w+\s+)?cover\s*$/i, // "Song - Cover", "Song - Acoustic Cover"
            /cover\s*ver\.?/i,
            /covered by/i,
            /as made famous by/i,
            /made famous by/i,
            /in the style of/i,
            /originally (performed|recorded|sung) by/i,
            /tribute to/i,
            /karaoke\s*version/i,
            /（カバー）/,
            /\(カバー\)/,
            /【カバー】/,
            /-\s*カバー\s*$/,
            /カバーver/i,
            /セルフカバー/,
            /歌ってみた/,
            /うたってみた/,
            /弾いてみた/,
        ];

        // "Cover factory" style labels commonly seen on Spotify.
        const ARTIST_PATTERNS = [
            /karaoke/i,
            /tribute (band|act)/i,
            /tribute to/i,
            /vitamin string quartet/i,
            /the hit crew/i,
            /ameritz/i,
            /starlite/i,
            /the studio sound ensemble/i,
            /covers? culture/i,
            /pianotribute/i,
            /sing king/i,
        ];

        const ALBUM_PATTERNS = [
            /karaoke/i,
            /tribute to/i, // not bare /tribute/: e.g. Ozzy Osbourne's original live album "Tribute"
            /\ba tribute\b/i,
            /made famous by/i,
            /in the style of/i,
            /cover\s*collection/i,
            /originally (performed|recorded) by/i,
            /（カバー/,
            /\(カバー/,
        ];

        function isEnabled() {
            return localStorage.getItem(STORAGE_KEY) !== "false"; // default: enabled
        }

        function setEnabled(value) {
            localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
        }

        function isStrictEnabled() {
            return localStorage.getItem(STRICT_STORAGE_KEY) !== "false"; // default: enabled
        }

        function setStrictEnabled(value) {
            localStorage.setItem(STRICT_STORAGE_KEY, value ? "true" : "false");
        }

        const whitelist = Util.createTrackList(Util.storageKey("coverSkip:whitelist"));
        const blacklist = Util.createTrackList(Util.storageKey("coverSkip:blacklist"));

        function detectCoverReason(track) {
            const name = track?.name || track?.metadata?.title;
            if (Util.matchesAny(TITLE_PATTERNS, name)) {
                return `曲名: ${name}`;
            }

            if (!isStrictEnabled()) return null;

            const artists = track?.artists || [];
            for (const artist of artists) {
                if (Util.matchesAny(ARTIST_PATTERNS, artist?.name)) {
                    return `アーティスト名: ${artist.name}`;
                }
            }

            const albumName = track?.album?.name || track?.metadata?.album_title;
            if (Util.matchesAny(ALBUM_PATTERNS, albumName)) {
                return `アルバム名: ${albumName}`;
            }

            return null;
        }

        // Pause instead of skipping forever when everything is a cover (e.g.
        // a karaoke album on repeat).
        const MAX_CONSECUTIVE_SKIPS = 10;
        let consecutiveSkips = 0;

        function handleSongChange() {
            const track = Spicetify.Player.data?.item;
            const uri = track?.uri;
            // Music only: episode titles can say "cover" for other reasons.
            if (!isEnabled() || !/^spotify:(track|local):/.test(uri || "")) {
                consecutiveSkips = 0;
                return;
            }

            const reason = blacklist.has(uri) ? "手動登録" : whitelist.has(uri) ? null : detectCoverReason(track);
            if (!reason) {
                consecutiveSkips = 0;
                return;
            }

            consecutiveSkips++;
            if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
                consecutiveSkips = 0;
                Spicetify.Player.pause();
                Spicetify.showNotification(`Cover曲が${MAX_CONSECUTIVE_SKIPS}曲連続したため再生を停止しました`);
                return;
            }

            Spicetify.showNotification(`Cover検出のためスキップ (${reason})`);
            Spicetify.Player.next();
        }

        Spicetify.Player.addEventListener("songchange", handleSongChange);

        Util.addContextMenuItem(
            "この曲はスキップしない",
            async (uris) => {
                const uri = uris[0];
                const meta = await Util.fetchTrackMeta(uri);
                whitelist.add(uri, meta);
                Spicetify.showNotification("この曲をホワイトリストに追加しました");
            },
            (uris) => uris.length === 1 && uris[0].startsWith("spotify:track:") && !whitelist.has(uris[0]) && !blacklist.has(uris[0]),
            "block"
        );

        Util.addContextMenuItem(
            "スキップしない設定を解除",
            (uris) => {
                whitelist.remove(uris[0]);
                Spicetify.showNotification("この曲をホワイトリストから削除しました");
            },
            (uris) => uris.length === 1 && uris[0].startsWith("spotify:track:") && whitelist.has(uris[0]),
            "check"
        );

        Util.addContextMenuItem(
            "この曲を常にスキップ",
            async (uris) => {
                const uri = uris[0];
                const meta = await Util.fetchTrackMeta(uri);
                blacklist.add(uri, meta);
                Spicetify.showNotification("この曲をブラックリストに追加しました");
            },
            (uris) => uris.length === 1 && uris[0].startsWith("spotify:track:") && !blacklist.has(uris[0]) && !whitelist.has(uris[0]),
            "skip-forward"
        );

        Util.addContextMenuItem(
            "常にスキップを解除",
            (uris) => {
                blacklist.remove(uris[0]);
                Spicetify.showNotification("この曲をブラックリストから削除しました");
            },
            (uris) => uris.length === 1 && uris[0].startsWith("spotify:track:") && blacklist.has(uris[0]),
            "x"
        );

        function buildSettingsSection() {
            const wrapper = document.createElement("div");

            wrapper.appendChild(
                Util.buildToggleRow("自動スキップを有効にする", isEnabled(), (checked) => {
                    setEnabled(checked);
                })
            );

            wrapper.appendChild(
                Util.buildToggleRow("アーティスト名・アルバム名も判定する", isStrictEnabled(), (checked) => {
                    setStrictEnabled(checked);
                })
            );

            wrapper.appendChild(Object.assign(document.createElement("hr"), { className: "mi3tweaks-divider" }));

            const whitelistHeading = document.createElement("h3");
            whitelistHeading.className = "mi3tweaks-subheading";
            whitelistHeading.textContent = "ホワイトリスト";
            wrapper.appendChild(whitelistHeading);

            wrapper.appendChild(
                Util.buildListSection(whitelist, (uri) => {
                    whitelist.remove(uri);
                    Spicetify.showNotification("ホワイトリストから削除しました");
                })
            );

            wrapper.appendChild(Object.assign(document.createElement("hr"), { className: "mi3tweaks-divider" }));

            const blacklistHeading = document.createElement("h3");
            blacklistHeading.className = "mi3tweaks-subheading";
            blacklistHeading.textContent = "ブラックリスト";
            wrapper.appendChild(blacklistHeading);

            wrapper.appendChild(
                Util.buildListSection(blacklist, (uri) => {
                    blacklist.remove(uri);
                    Spicetify.showNotification("ブラックリストから削除しました");
                })
            );

            return wrapper;
        }

        return {
            id: "coverSkip",
            title: "Cover Skip",
            buildSettingsSection,
        };
    }

    // =======================================================================
    // Feature: YouTube Link Copy
    // Copies the top video link with an API key, or a search page link without.
    // =======================================================================
    function createYoutubeLinkFeature(Util) {
        const API_KEY_STORAGE = Util.storageKey("youtubeLink:apiKey");
        const USE_API_KEY_STORAGE = Util.storageKey("youtubeLink:useApiKey");

        function getApiKey() {
            return localStorage.getItem(API_KEY_STORAGE) || "";
        }

        function setApiKey(value) {
            if (value) {
                localStorage.setItem(API_KEY_STORAGE, value);
            } else {
                localStorage.removeItem(API_KEY_STORAGE);
            }
        }

        function isApiKeyUsageEnabled() {
            return localStorage.getItem(USE_API_KEY_STORAGE) !== "false"; // default: enabled
        }

        function setApiKeyUsageEnabled(value) {
            localStorage.setItem(USE_API_KEY_STORAGE, value ? "true" : "false");
        }

        function buildSearchPageUrl(query) {
            return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        }

        async function resolveYoutubeUrl(query) {
            const apiKey = getApiKey();
            if (!apiKey || !isApiKeyUsageEnabled()) {
                return { url: buildSearchPageUrl(query), isDirectVideo: false };
            }

            try {
                const endpoint = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;
                const res = await fetch(endpoint);
                if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
                const data = await res.json();
                const videoId = data?.items?.[0]?.id?.videoId;
                if (!videoId) throw new Error("No YouTube videos found");
                return { url: `https://www.youtube.com/watch?v=${videoId}`, isDirectVideo: true };
            } catch (e) {
                console.warn("[mi3Tweaks][YoutubeLink] API search failed, falling back to search page link", e);
                return { url: buildSearchPageUrl(query), isDirectVideo: false };
            }
        }

        async function copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (e) {
                try {
                    const textarea = document.createElement("textarea");
                    textarea.value = text;
                    textarea.style.position = "fixed";
                    textarea.style.opacity = "0";
                    document.body.appendChild(textarea);
                    textarea.focus();
                    textarea.select();
                    const ok = document.execCommand("copy");
                    document.body.removeChild(textarea);
                    return ok;
                } catch (e2) {
                    return false;
                }
            }
        }

        Util.addContextMenuItem(
            "YouTubeリンクをコピー",
            async (uris) => {
                const uri = uris[0];
                const meta = await Util.fetchTrackMeta(uri);
                if (!meta?.name) {
                    Spicetify.showNotification("トラック情報の取得に失敗しました");
                    return;
                }

                const query = meta.artist ? `${meta.name} ${meta.artist}` : meta.name;
                const { url, isDirectVideo } = await resolveYoutubeUrl(query);

                const copied = await copyToClipboard(url);
                if (!copied) {
                    Spicetify.showNotification("クリップボードへのコピーに失敗しました");
                    return;
                }

                Spicetify.showNotification(
                    isDirectVideo ? "YouTube動画リンクをコピーしました" : "YouTube検索リンクをコピーしました"
                );
            },
            (uris) => uris.length === 1 && uris[0].startsWith("spotify:track:"),
            "external-link"
        );

        function buildSettingsSection() {
            const wrapper = document.createElement("div");

            wrapper.appendChild(
                Util.buildToggleRow("APIキーを使用する", isApiKeyUsageEnabled(), (checked) => {
                    setApiKeyUsageEnabled(checked);
                })
            );

            wrapper.appendChild(
                Util.buildTextInputRow("YouTube Data API v3 キー", getApiKey(), "AIza...", (value) => {
                    setApiKey(value);
                })
            );

            return wrapper;
        }

        return {
            id: "youtubeLink",
            title: "YouTube Link Copy",
            buildSettingsSection,
        };
    }

    // =======================================================================
    // Feature: Volume Hotkeys
    // Mousetrap (behind Spicetify.Keyboard) ignores keys while typing in an
    // input, so these don't fire in the search box.
    // =======================================================================
    function createVolumeHotkeysFeature(Util) {
        const STORAGE_KEY = Util.storageKey("volumeHotkeys:enabled");

        function isEnabled() {
            return localStorage.getItem(STORAGE_KEY) !== "false"; // default: enabled
        }

        function setEnabled(value) {
            localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
        }

        for (let digit = 0; digit <= 9; digit++) {
            const level = digit === 0 ? 1 : digit / 10;
            Spicetify.Keyboard.registerShortcut(String(digit), () => {
                if (!isEnabled()) return;
                Spicetify.Player.setVolume(level);
            });
        }

        // Clicks the native mute button, so unmuting restores the old volume.
        Spicetify.Keyboard.registerShortcut("m", () => {
            if (!isEnabled()) return;
            Spicetify.Player.toggleMute();
        });

        function buildSettingsSection() {
            const wrapper = document.createElement("div");

            const hint = document.createElement("p");
            hint.className = "mi3tweaks-hint";
            hint.textContent =
                "数字キーの1〜0で音量を10%〜100%に設定します。Mキーでミュートを切り替えます。";
            wrapper.appendChild(hint);

            wrapper.appendChild(
                Util.buildToggleRow("キーボードでの音量操作を有効にする", isEnabled(), (checked) => {
                    setEnabled(checked);
                })
            );

            return wrapper;
        }

        return {
            id: "volumeHotkeys",
            title: "Volume Hotkeys",
            buildSettingsSection,
        };
    }

    // =======================================================================
    // Settings modal and menus
    // =======================================================================
    const features = [createCoverSkipFeature(Util), createYoutubeLinkFeature(Util), createVolumeHotkeysFeature(Util)];

    function openSettingsModal() {
        Util.injectStylesOnce();

        const wrapper = document.createElement("div");
        wrapper.className = "mi3tweaks-settings";

        features.forEach((feature, i) => {
            if (i > 0) {
                wrapper.appendChild(Object.assign(document.createElement("hr"), { className: "mi3tweaks-divider mi3tweaks-divider-feature" }));
            }
            const heading = document.createElement("h2");
            heading.className = "mi3tweaks-feature-heading";
            heading.textContent = feature.title;
            wrapper.appendChild(heading);
            wrapper.appendChild(feature.buildSettingsSection());
        });

        Spicetify.PopupModal.display({
            title: "mi3Tweaks Settings",
            content: wrapper,
        });
    }

    Util.refreshSettingsModal = openSettingsModal;

    // Spicetify wraps this in <svg viewBox="0 0 16 16" fill="currentColor">,
    // so it follows the menu text color like the built-in icons.
    const APP_ICON =
        '<path d="M3 7L3.5 1.75L6.5 4.5H9.5L12.5 1.75L13 7C13 11 11 14 8 14C5 14 3 11 3 7Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<circle cx="6" cy="9.5" r="1.1"/><circle cx="10" cy="9.5" r="1.1"/>';

    new Spicetify.Menu.Item("mi3Tweaks Settings", false, () => openSettingsModal(), APP_ICON).register();

    // The submenu shows only when at least one of its items would.
    function anySubItemShouldAdd(uris, uids, contextUri) {
        return Util.contextMenuShouldAdds.some((shouldAdd) => {
            try {
                return shouldAdd(uris, uids, contextUri);
            } catch (e) {
                return false;
            }
        });
    }

    // The 5th `icon` argument isn't in globals.d.ts but SubMenu accepts it.
    new Spicetify.ContextMenu.SubMenu("mi3Tweaks", Util.contextMenuItems, anySubItemShouldAdd, false, APP_ICON).register();

    console.log("[mi3Tweaks] Loaded features:", features.map((f) => f.id).join(", "));
})();
