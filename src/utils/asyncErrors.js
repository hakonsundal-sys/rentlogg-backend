// Express 4 only catches an error thrown synchronously from a handler. An `async` handler that
// throws after its first `await` returns a rejected promise nobody is listening to, and on Node 22
// an unhandled rejection ends the whole process: one bad photo upload (say a `kind` the database's
// CHECK constraint refuses) took the API down for every user until Render restarted it.
//
// This patches the one place Express 4 calls every route handler and middleware, so a rejected
// promise is passed to next(err) exactly like a thrown error — including in routes written later.
// Express 5 does this natively, and this file can be deleted when the project moves to it.
import Layer from "express/lib/router/layer.js";

const original = Layer.prototype.handle_request;

Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return original.call(this, req, res, next); // an error handler, not a request handler
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === "function") result.catch(next);
  } catch (err) {
    next(err);
  }
};
