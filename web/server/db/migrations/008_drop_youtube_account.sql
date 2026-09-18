-- Removes the connected YouTube account.
--
-- It worked, and it was not worth what it cost to reach. Following the
-- playlists in somebody's own YouTube account needs their permission;
-- permission needs OAuth; Google issues OAuth credentials only to a registered
-- application. So every instance owner had to create a Google Cloud project,
-- enable an API, register a client, and paste two values into Settings - and
-- then, because `youtube.readonly` is a sensitive scope, add their own address
-- to that client's Test users list before sign-in would work at all - and even
-- then it commonly ends at "Error 403: access_denied".
--
-- Following a public playlist link does the same job, from five services, and
-- asks for none of it.
--
-- This is a one-way door and deliberately so. The schema for a feature nobody
-- can use is worse than either keeping it working or removing it properly.
-- Re-adding it means a new migration plus the service and route modules; the
-- provider layer is unchanged, so that is contained work rather than a rewrite.

DROP INDEX IF EXISTS youtube_playlists_selected_idx;
DROP TABLE IF EXISTS youtube_playlists;
DROP TABLE IF EXISTS youtube_accounts;

-- The OAuth client credentials. Nothing reads these any more, and leaving them
-- would keep them in the Settings API response with no field to render them.
DELETE FROM app_settings WHERE key LIKE 'google.%';

-- `youtube.enabled` stays. YouTube search, playlist import and the resolver's
-- last tier all still use it, and all three need no credentials whatsoever.
