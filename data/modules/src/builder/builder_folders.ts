// =============================================================================
// Builder folders — per-user project / client folders for Curio Builder.
//
// One RPC, `builder_folders_sync`, with three ops:
//   get   → returns the caller's folders and the storage version
//   save  → replaces the folder list; optimistic concurrency via `version`
//   purge → deletes the caller's folder list (delete-all / unpair path)
//
// Owner-only: ctx.userId is the only key used, the object is readable by its
// owner and writable only by the server (permissionWrite 0). Clients never
// write storage directly.
// =============================================================================

namespace BuilderFolders {

  const COLLECTION = "builder_folders";
  const KEY = "workspace";

  const MAX_PAYLOAD_CHARS = 65536;
  const MAX_FOLDERS = 50;
  const MAX_NOTES_PER_FOLDER = 500;
  const MAX_NAME_CHARS = 60;
  const MAX_ID_CHARS = 128;
  const ALLOWED_KINDS: { [k: string]: boolean } = { project: true, client: true };
  const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

  interface Folder {
    id: string;
    name: string;
    kind: string;
    noteIds: string[];
  }

  function validateFolder(raw: any, seenIds: { [k: string]: boolean }): { folder?: Folder; error?: string } {
    if (!raw || typeof raw !== "object") return { error: "folder must be an object" };

    var id = typeof raw.id === "string" ? raw.id : "";
    if (!id || id.length > MAX_ID_CHARS || !ID_PATTERN.test(id)) {
      return { error: "folder id must be 1-128 letters, digits, '_' or '-'" };
    }
    if (seenIds[id]) return { error: "duplicate folder id: " + id };

    var name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || name.length > MAX_NAME_CHARS) {
      return { error: "folder name must be 1-60 characters" };
    }

    var kind = typeof raw.kind === "string" ? raw.kind.toLowerCase() : "";
    if (!ALLOWED_KINDS[kind]) return { error: "folder kind must be project or client" };

    var notes = raw.noteIds === undefined || raw.noteIds === null ? [] : raw.noteIds;
    if (!Array.isArray(notes)) return { error: "noteIds must be an array" };
    if (notes.length > MAX_NOTES_PER_FOLDER) {
      return { error: "a folder holds at most " + MAX_NOTES_PER_FOLDER + " notes" };
    }
    var noteIds: string[] = [];
    var seenNotes: { [k: string]: boolean } = {};
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (typeof n !== "string" || !n || n.length > MAX_ID_CHARS) {
        return { error: "each noteId must be a 1-128 character string" };
      }
      if (seenNotes[n]) continue;
      seenNotes[n] = true;
      noteIds.push(n);
    }

    seenIds[id] = true;
    return { folder: { id: id, name: name, kind: kind, noteIds: noteIds } };
  }

  function readWorkspace(nk: nkruntime.Nakama, userId: string): { folders: Folder[]; version: string; updatedAt: string } {
    var rows = nk.storageRead([{ collection: COLLECTION, key: KEY, userId: userId }]);
    if (!rows || rows.length === 0) return { folders: [], version: "", updatedAt: "" };
    var row = rows[0];
    var value: any = row.value || {};
    return {
      folders: Array.isArray(value.folders) ? value.folders : [],
      version: row.version || "",
      updatedAt: value.updatedAt || "",
    };
  }

  function rpcBuilderFoldersSync(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      if (!ctx.userId) {
        return RpcHelpers.errorResponse("User ID is required", 401);
      }
      var userId = ctx.userId;
      if (payload && payload.length > MAX_PAYLOAD_CHARS) {
        return RpcHelpers.errorResponse("payload too large", 413);
      }
      var data = RpcHelpers.parseRpcPayload(payload) || {};
      var op = typeof data.op === "string" ? data.op : "get";

      if (op === "get") {
        var current = readWorkspace(nk, userId);
        return RpcHelpers.successResponse({
          folders: current.folders,
          version: current.version,
          updatedAt: current.updatedAt,
        });
      }

      if (op === "purge") {
        nk.storageDelete([{ collection: COLLECTION, key: KEY, userId: userId }]);
        return RpcHelpers.successResponse({ purged: true });
      }

      if (op !== "save") {
        return RpcHelpers.errorResponse("op must be get, save or purge", 400);
      }

      if (!Array.isArray(data.folders)) {
        return RpcHelpers.errorResponse("folders must be an array", 400);
      }
      if (data.folders.length > MAX_FOLDERS) {
        return RpcHelpers.errorResponse("at most " + MAX_FOLDERS + " folders", 400);
      }

      var seenIds: { [k: string]: boolean } = {};
      var folders: Folder[] = [];
      for (var i = 0; i < data.folders.length; i++) {
        var result = validateFolder(data.folders[i], seenIds);
        if (result.error) return RpcHelpers.errorResponse(result.error, 400);
        folders.push(result.folder);
      }

      var before = readWorkspace(nk, userId);
      if (typeof data.version === "string" && data.version !== before.version) {
        return RpcHelpers.errorResponse("folders changed on another device; reload and retry", 409);
      }

      var updatedAt = new Date().toISOString();
      try {
        var acks = nk.storageWrite([{
          collection: COLLECTION,
          key: KEY,
          userId: userId,
          value: { folders: folders, updatedAt: updatedAt },
          version: before.version || "*",
          permissionRead: 1,
          permissionWrite: 0,
        }]);
        var newVersion = acks && acks.length > 0 ? acks[0].version : "";
        return RpcHelpers.successResponse({
          folders: folders,
          version: newVersion,
          updatedAt: updatedAt,
        });
      } catch (writeErr: any) {
        logger.warn("[BuilderFolders] version conflict for " + userId + ": " + (writeErr && writeErr.message ? writeErr.message : String(writeErr)));
        return RpcHelpers.errorResponse("folders changed on another device; reload and retry", 409);
      }
    } catch (err: any) {
      var msg = err && err.message ? err.message : String(err);
      logger.error("[BuilderFolders] sync failed: " + msg);
      return RpcHelpers.errorResponse("builder_folders_sync failed", 500);
    }
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("builder_folders_sync", rpcBuilderFoldersSync);
  }
}
