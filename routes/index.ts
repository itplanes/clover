"use strict";
/// <reference path="../typings/filesize.d.ts" />

import Router = require("koa-router");
const router = new Router();
import config from "../lib/config";
import User from "../models/user";
import Announce from "../models/announce";
import { connection } from "../lib/db";
import log from "../lib/log";
import { announce as announceMail } from "../lib/email";
// tslint:disable-next-line:no-var-requires
const filesize: any = require("filesize");

declare module "koa" {
  // tslint:disable-next-line
  interface Context {
    user: User;
  }
}

const site = {
  title: config.get("site_title"),
};
const checkAuth = async (ctx: Router.IRouterContext, redirectDashboard = true, redirectIndex = true) => {
  let authorized = false;
  if (ctx.session.uid) {
    const result = await connection.getRepository(User).findOneById(ctx.session.uid);
    if (result) {
      ctx.user = result;
      authorized = true;
    }
  }
  if (authorized) {
    if (redirectDashboard) {
      ctx.redirect("/dashboard");
    }
  } else {
    if (redirectIndex) {
      ctx.redirect("/");
    }
  }
};
router.get("/", async (ctx) => {
  await checkAuth(ctx, true, false);
  await ctx.render("index", {
    site: { ...site },
  });
});
router.post("/login", async (ctx) => {
  if ((!ctx.request.body.email) || (!ctx.request.body.password)) {
    // TODO: better output
    ctx.throw(400);
  } else {
    const user = await connection.getRepository(User).findOne({
      email: ctx.request.body.email,
    });
    // TODO check the two
    if (!user || !(await user.checkPassword(ctx.request.body.password))) {
      // TODO: better output
      ctx.throw(403);
    } else {
      ctx.session.uid = user.id;
      ctx.response.redirect("/dashboard");
    }
  }
});
router.post("/reg", async (ctx, next) => {
  if ((!ctx.request.body.email) ||
    (!ctx.request.body.password) ||
    (!ctx.request.body.password2)) {
    // TODO: better output
    ctx.throw(400);
  } else if (ctx.request.body.password !== ctx.request.body.password2) {
    // TODO: better output
    ctx.throw(400, "password and password2 mismatch");
  } else {
    const user = new User(ctx.request.body.email);
    await user.setPassword(ctx.request.body.password);
    user.setConnPassword();
    await user.allocConnPort();
    await connection.getRepository(User).persist(user);
    ctx.session.uid = user.id;
    ctx.response.redirect("/dashboard");
  }
});
router.get("/dashboard", async (ctx) => {
  await checkAuth(ctx, false);
  const cards = [];
  {
    const announces = await connection.getRepository(Announce)
      .find({ take: 2, order: { updatedAt: "DESC" } });
    for (const announce of announces) {
      cards.push({ isAnnouncement: true, ...announce });
    }
  }
  cards.sort((a, b) => (a.updatedAt > b.createdAt ? -1 : 1));
  await ctx.render("dashboard", {
    site: { ...site },
    // TODO: change these to real
    user: { email: ctx.user.email },
    bandwidth: {
      used: filesize(ctx.user.bandwidthUsed),
      start: config.get("bandwidth_start"),
    },
    // tslint:disable-next-line:object-literal-shorthand
    cards: cards,
  });
});
router.get("/updates", async (ctx) => {
  await checkAuth(ctx, false);
  const cards: any = await connection.getRepository(Announce)
    .find({ take: 10, order: { updatedAt: "DESC" } });
  for (const card of cards) {
    card.isAnnouncement = true;
  }
  await ctx.render("updates", {
    site: { ...site },
    user: { email: ctx.user.email },
    // TODO: change these to real
    bandwidth: {
      used: filesize(ctx.user.bandwidthUsed),
      start: config.get("bandwidth_start"),
    },
    // tslint:disable-next-line:object-literal-shorthand
    cards: cards,
  });
});
router.get("/logout", (ctx) => {
  ctx.session = null;
  ctx.response.redirect("/");
});
router.use("/admin", async (ctx, next) => {
  await checkAuth(ctx, false);
  if (ctx.user.isAdmin) {
    await next();
  } else {
    ctx.redirect("/dashboard");
  }
});
router.get("/admin", async (ctx) => {
  await ctx.render("admin-index", {
    site: { ...site },
  });
});
// TODO: support announce update
router.get("/admin/announces", async (ctx) => {
  await ctx.render("admin-announces", {
    site: { ...site },
  });
});
router.post("/admin/announces", async (ctx) => {
  const announce = new Announce(ctx.request.body.title, ctx.request.body.content);
  await connection.getRepository(Announce).persist(announce);
  const users = await connection.getRepository(User).find();
  // TODO: use job queues
  await announceMail(announce, users);
  // TODO: better appearance
  ctx.response.status = 200;
  ctx.response.type = "text/html";
  ctx.response.body = `Succeeded.<a href="/admin">Go back</a>`;
});
router.get("/mu/v2/users", async (ctx) => {
  if (ctx.request.header.token !== config.get("mu_token")) {
    ctx.throw(401);
  } else {
    const users = await connection.getRepository(User).find();
    const data = [];
    for (const user of users) {
      data.push({
        id: user.id,
        passwd: user.connPassword,
        t: user.updatedAt.getTime(),
        u: 0,
        d: user.bandwidthUsed,
        transfer_enable: user.bandwidthUsed + 200000000,
        port: user.connPort,
        switch: user.enabled ? 1 : 0,
        enable: user.enabled ? 1 : 0,
        method: user.connEnc,
      });
    }
    ctx.response.set("Content-Type", "application/json");
    ctx.response.body = JSON.stringify({
      msg: "ok",
      data,
    });
  }
});
router.post("/mu/v2/users/:id/traffic", async (ctx) => {
  if (ctx.request.header.token !== config.get("mu_token")) {
    ctx.throw(401);
  } else {
    const user = await connection.getRepository(User).findOneById(ctx.params.id);
    if (!user) {
      ctx.throw(404);
    } else if ((!ctx.request.body.u) && (!ctx.request.body.d)) {
      ctx.throw(400);
    } else {
      user.bandwidthUsed += parseInt(ctx.request.body.u, 10);
      user.bandwidthUsed += parseInt(ctx.request.body.d, 10);
      await connection.getRepository(User).persist(user);
      ctx.response.set("Content-Type", "application/json");
      ctx.response.body = JSON.stringify({
        ret: 1,
        msg: "ok",
      });
    }
  }
});

export = router;
