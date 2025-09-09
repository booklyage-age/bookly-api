import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import bodyParser from "body-parser";

dotenv.config();
const app = express();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// função util para converter timestamps unix → ISO
const safeDate = (ts) => (ts ? new Date(ts * 1000).toISOString() : null);

// 🚀 rota teste
app.get("/", (req, res) => {
  res.send("🚀 API Stripe + Supabase no ar!");
});

// ✅ JSON apenas para rotas normais
app.use("/api", express.json());

// 🔹 Criar sessão de checkout (trial 14 dias)
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { email, user_id } = req.body;

    if (!email || !user_id) {
      return res.status(400).json({ error: "email e user_id são obrigatórios" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 14,
        metadata: { user_id },
      },
      customer_email: email,
      metadata: { user_id },
      // ✅ agora vai ao login depois do checkout
      success_url: `${process.env.DOMAIN}/login?session_id={CHECKOUT_SESSION_ID}`, 
      cancel_url: `${process.env.DOMAIN}/subscribe`,
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erro ao criar Checkout Session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Criar sessão do Customer Portal
app.post("/api/create-portal-session", express.json(), async (req, res) => {
  try {

    console.log("DOMAIN:",
      process.env.DOMAIN);
    const { customerId } = req.body; // vem do Supabase ou da sessão do utilizador

    if (!customerId) {
      return res.status(400).json({ error: "customerId é obrigatório" });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.DOMAIN}/dashboard`, // volta para a dashboard depois
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error("❌ Erro ao criar Portal Session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ⚡ Webhook da Stripe (não usa express.json)
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Erro no webhook:", err.message);
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    // 👉 checkout concluído
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.mode === "subscription") {
        try {
          const subscription = await stripe.subscriptions.retrieve(
            session.subscription
          );

          // 🔹 salvar apenas dados básicos
          const { error } = await supabase.from("subscriptions").upsert(
            {
              user_id: session.metadata.user_id || subscription.metadata?.user_id,
              stripe_customer_id: subscription.customer,
              stripe_subscription_id: subscription.id,
              stripe_price_id: subscription.items.data[0].price.id,
              status: subscription.status,
              trial_start: safeDate(subscription.trial_start),
              trial_end: safeDate(subscription.trial_end),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          );

          if (error) {
            console.error("❌ Erro ao salvar subscrição (checkout):", error);
          } else {
            console.log("✅ Subscrição inicial salva:", subscription.id);
          }
        } catch (err) {
          console.error("❌ Erro ao processar checkout.session.completed:", err.message);
        }
      }
    }

    // 👉 subscription criada/atualizada/cancelada
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object;

      try {
        const { error } = await supabase.from("subscriptions").upsert(
          {
            user_id: subscription.metadata?.user_id,
            stripe_customer_id: subscription.customer,
            stripe_subscription_id: subscription.id,
            stripe_price_id: subscription.items.data[0].price.id,
            status: subscription.status,
            current_period_start: safeDate(subscription.current_period_start),
            current_period_end: safeDate(subscription.current_period_end),
            trial_start: safeDate(subscription.trial_start),
            trial_end: safeDate(subscription.trial_end),
            cancel_at: safeDate(subscription.cancel_at),
            canceled_at: safeDate(subscription.canceled_at),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        );

        if (error) {
          console.error("❌ Erro ao atualizar subscrição:", error);
        } else {
          console.log("✅ Subscrição atualizada:", subscription.id);
        }
      } catch (err) {
        console.error("❌ Erro ao processar subscription event:", err.message);
      }
    }

    res.json({ received: true });
  }
);

// 🚀 Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor a rodar em http://localhost:${PORT}`);
});
