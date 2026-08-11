export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      corporate_actions: {
        Row: {
          action_type: string
          amount: number | null
          applied_at: string | null
          created_at: string
          ex_date: string
          exchange: string
          id: string
          purpose: string | null
          ratio_from: number | null
          ratio_to: number | null
          source: string
          symbol: string
          updated_at: string
        }
        Insert: {
          action_type: string
          amount?: number | null
          applied_at?: string | null
          created_at?: string
          ex_date: string
          exchange?: string
          id?: string
          purpose?: string | null
          ratio_from?: number | null
          ratio_to?: number | null
          source?: string
          symbol: string
          updated_at?: string
        }
        Update: {
          action_type?: string
          amount?: number | null
          applied_at?: string | null
          created_at?: string
          ex_date?: string
          exchange?: string
          id?: string
          purpose?: string | null
          ratio_from?: number | null
          ratio_to?: number | null
          source?: string
          symbol?: string
          updated_at?: string
        }
        Relationships: []
      }
      fii_dii_activity: {
        Row: {
          activity_date: string
          dii_gross_buy: number | null
          dii_gross_sell: number | null
          dii_net: number | null
          fii_gross_buy: number | null
          fii_gross_sell: number | null
          fii_net: number | null
          net_buy_inr_cr: number | null
          segment: string
          source: string | null
          updated_at: string
        }
        Insert: {
          activity_date: string
          dii_gross_buy?: number | null
          dii_gross_sell?: number | null
          dii_net?: number | null
          fii_gross_buy?: number | null
          fii_gross_sell?: number | null
          fii_net?: number | null
          net_buy_inr_cr?: number | null
          segment?: string
          source?: string | null
          updated_at?: string
        }
        Update: {
          activity_date?: string
          dii_gross_buy?: number | null
          dii_gross_sell?: number | null
          dii_net?: number | null
          fii_gross_buy?: number | null
          fii_gross_sell?: number | null
          fii_net?: number | null
          net_buy_inr_cr?: number | null
          segment?: string
          source?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      market_alert_events: {
        Row: {
          alert_id: string
          channel: string | null
          created_at: string
          delivered_at: string | null
          error: string | null
          exchange: string
          id: string
          meta: Json | null
          symbol: string
          trigger_value: number | null
          triggered_at: string
          user_id: string
        }
        Insert: {
          alert_id: string
          channel?: string | null
          created_at?: string
          delivered_at?: string | null
          error?: string | null
          exchange?: string
          id?: string
          meta?: Json | null
          symbol: string
          trigger_value?: number | null
          triggered_at?: string
          user_id?: string
        }
        Update: {
          alert_id?: string
          channel?: string | null
          created_at?: string
          delivered_at?: string | null
          error?: string | null
          exchange?: string
          id?: string
          meta?: Json | null
          symbol?: string
          trigger_value?: number | null
          triggered_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "market_alert_events_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "market_alerts"
            referencedColumns: ["id"]
          },
        ]
      }
      market_alerts: {
        Row: {
          alert_type: string
          channel: Database["public"]["Enums"]["market_alert_channel"]
          config: Json | null
          created_at: string
          exchange: string
          id: string
          is_active: boolean
          last_error: string | null
          symbol: string
          threshold: number | null
          triggered_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          alert_type: string
          channel?: Database["public"]["Enums"]["market_alert_channel"]
          config?: Json | null
          created_at?: string
          exchange?: string
          id?: string
          is_active?: boolean
          last_error?: string | null
          symbol: string
          threshold?: number | null
          triggered_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          alert_type?: string
          channel?: Database["public"]["Enums"]["market_alert_channel"]
          config?: Json | null
          created_at?: string
          exchange?: string
          id?: string
          is_active?: boolean
          last_error?: string | null
          symbol?: string
          threshold?: number | null
          triggered_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_api_settings: {
        Row: {
          access_token_enc: string | null
          active_provider: Database["public"]["Enums"]["market_provider"]
          api_secret_enc: string | null
          base_url: string | null
          connection_status: Database["public"]["Enums"]["market_connection_status"]
          consumer_key: string | null
          consumer_secret_enc: string | null
          created_at: string
          data_center: string | null
          exchange: string | null
          funds_last_attempt_at: string | null
          funds_last_error_code: string | null
          funds_retry_after_at: string | null
          greeting_name: string | null
          hs_server_id: string | null
          id: string
          imei: string | null
          is_system: boolean
          last_error: string | null
          last_sync_at: string | null
          mobile_number_enc: string | null
          mpin_enc: string | null
          password_enc: string | null
          purpose: string
          rate_limit: number | null
          rid: string | null
          session_token_enc: string | null
          sid: string | null
          token_expires_at: string | null
          totp_secret_enc: string | null
          ucc: string | null
          updated_at: string
          user_id: string
          vendor_code: string | null
          view_token_enc: string | null
          ws_url: string | null
        }
        Insert: {
          access_token_enc?: string | null
          active_provider?: Database["public"]["Enums"]["market_provider"]
          api_secret_enc?: string | null
          base_url?: string | null
          connection_status?: Database["public"]["Enums"]["market_connection_status"]
          consumer_key?: string | null
          consumer_secret_enc?: string | null
          created_at?: string
          data_center?: string | null
          exchange?: string | null
          funds_last_attempt_at?: string | null
          funds_last_error_code?: string | null
          funds_retry_after_at?: string | null
          greeting_name?: string | null
          hs_server_id?: string | null
          id?: string
          imei?: string | null
          is_system?: boolean
          last_error?: string | null
          last_sync_at?: string | null
          mobile_number_enc?: string | null
          mpin_enc?: string | null
          password_enc?: string | null
          purpose?: string
          rate_limit?: number | null
          rid?: string | null
          session_token_enc?: string | null
          sid?: string | null
          token_expires_at?: string | null
          totp_secret_enc?: string | null
          ucc?: string | null
          updated_at?: string
          user_id?: string
          vendor_code?: string | null
          view_token_enc?: string | null
          ws_url?: string | null
        }
        Update: {
          access_token_enc?: string | null
          active_provider?: Database["public"]["Enums"]["market_provider"]
          api_secret_enc?: string | null
          base_url?: string | null
          connection_status?: Database["public"]["Enums"]["market_connection_status"]
          consumer_key?: string | null
          consumer_secret_enc?: string | null
          created_at?: string
          data_center?: string | null
          exchange?: string | null
          funds_last_attempt_at?: string | null
          funds_last_error_code?: string | null
          funds_retry_after_at?: string | null
          greeting_name?: string | null
          hs_server_id?: string | null
          id?: string
          imei?: string | null
          is_system?: boolean
          last_error?: string | null
          last_sync_at?: string | null
          mobile_number_enc?: string | null
          mpin_enc?: string | null
          password_enc?: string | null
          purpose?: string
          rate_limit?: number | null
          rid?: string | null
          session_token_enc?: string | null
          sid?: string | null
          token_expires_at?: string | null
          totp_secret_enc?: string | null
          ucc?: string | null
          updated_at?: string
          user_id?: string
          vendor_code?: string | null
          view_token_enc?: string | null
          ws_url?: string | null
        }
        Relationships: []
      }
      market_archive_index: {
        Row: {
          archived_at: string
          bars: number
          bytes: number
          exchange: string
          first_date: string | null
          last_date: string | null
          object_path: string
          symbol: string
          updated_at: string
        }
        Insert: {
          archived_at?: string
          bars?: number
          bytes?: number
          exchange?: string
          first_date?: string | null
          last_date?: string | null
          object_path: string
          symbol: string
          updated_at?: string
        }
        Update: {
          archived_at?: string
          bars?: number
          bytes?: number
          exchange?: string
          first_date?: string | null
          last_date?: string | null
          object_path?: string
          symbol?: string
          updated_at?: string
        }
        Relationships: []
      }
      market_autotrade_log: {
        Row: {
          created_at: string
          id: string
          level: string
          message: string
          meta: Json | null
          rule_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          level: string
          message: string
          meta?: Json | null
          rule_id?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          level?: string
          message?: string
          meta?: Json | null
          rule_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "market_autotrade_log_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "market_autotrade_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      market_autotrade_orders: {
        Row: {
          broker_order_id: string | null
          broker_sl_order_id: string | null
          created_at: string
          exchange: string
          filled_at: string | null
          filled_price: number | null
          high_water_ltp: number | null
          id: string
          last_broker_sync_at: string | null
          leg: string
          order_type: string
          placed_at: string | null
          product: string
          quantity: number
          reason: string | null
          requested_price: number | null
          rule_id: string | null
          side: string
          status: string
          symbol: string
          user_id: string
        }
        Insert: {
          broker_order_id?: string | null
          broker_sl_order_id?: string | null
          created_at?: string
          exchange?: string
          filled_at?: string | null
          filled_price?: number | null
          high_water_ltp?: number | null
          id?: string
          last_broker_sync_at?: string | null
          leg: string
          order_type?: string
          placed_at?: string | null
          product?: string
          quantity: number
          reason?: string | null
          requested_price?: number | null
          rule_id?: string | null
          side: string
          status?: string
          symbol: string
          user_id?: string
        }
        Update: {
          broker_order_id?: string | null
          broker_sl_order_id?: string | null
          created_at?: string
          exchange?: string
          filled_at?: string | null
          filled_price?: number | null
          high_water_ltp?: number | null
          id?: string
          last_broker_sync_at?: string | null
          leg?: string
          order_type?: string
          placed_at?: string | null
          product?: string
          quantity?: number
          reason?: string | null
          requested_price?: number | null
          rule_id?: string | null
          side?: string
          status?: string
          symbol?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "market_autotrade_orders_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "market_autotrade_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      market_autotrade_rules: {
        Row: {
          created_at: string
          entry_conditions: Json
          exchange: string
          exit_conditions: Json
          exit_order_type: string
          id: string
          is_armed: boolean
          limit_offset_pct: number | null
          name: string
          order_type: string
          product: string
          sizing_mode: string
          sizing_value: number
          stop_loss_pct: number | null
          symbol: string | null
          target_pct: number | null
          trail_stop_pct: number | null
          updated_at: string
          user_id: string
          watchlist_id: string | null
        }
        Insert: {
          created_at?: string
          entry_conditions?: Json
          exchange?: string
          exit_conditions?: Json
          exit_order_type?: string
          id?: string
          is_armed?: boolean
          limit_offset_pct?: number | null
          name: string
          order_type?: string
          product?: string
          sizing_mode?: string
          sizing_value?: number
          stop_loss_pct?: number | null
          symbol?: string | null
          target_pct?: number | null
          trail_stop_pct?: number | null
          updated_at?: string
          user_id?: string
          watchlist_id?: string | null
        }
        Update: {
          created_at?: string
          entry_conditions?: Json
          exchange?: string
          exit_conditions?: Json
          exit_order_type?: string
          id?: string
          is_armed?: boolean
          limit_offset_pct?: number | null
          name?: string
          order_type?: string
          product?: string
          sizing_mode?: string
          sizing_value?: number
          stop_loss_pct?: number | null
          symbol?: string | null
          target_pct?: number | null
          trail_stop_pct?: number | null
          updated_at?: string
          user_id?: string
          watchlist_id?: string | null
        }
        Relationships: []
      }
      market_autotrade_settings: {
        Row: {
          created_at: string
          daily_loss_limit: number
          disabled_at: string | null
          disabled_reason: string | null
          enabled: boolean
          eval_lock_at: string | null
          max_capital_per_rule: number
          max_open_positions: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          daily_loss_limit?: number
          disabled_at?: string | null
          disabled_reason?: string | null
          enabled?: boolean
          eval_lock_at?: string | null
          max_capital_per_rule?: number
          max_open_positions?: number
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          daily_loss_limit?: number
          disabled_at?: string | null
          disabled_reason?: string | null
          enabled?: boolean
          eval_lock_at?: string | null
          max_capital_per_rule?: number
          max_open_positions?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_backtest_results: {
        Row: {
          created_at: string
          equity_curve: Json | null
          id: string
          metrics: Json | null
          period_years: number | null
          ran_at: string
          strategy_id: string | null
          trades: Json | null
          user_id: string
        }
        Insert: {
          created_at?: string
          equity_curve?: Json | null
          id?: string
          metrics?: Json | null
          period_years?: number | null
          ran_at?: string
          strategy_id?: string | null
          trades?: Json | null
          user_id?: string
        }
        Update: {
          created_at?: string
          equity_curve?: Json | null
          id?: string
          metrics?: Json | null
          period_years?: number | null
          ran_at?: string
          strategy_id?: string | null
          trades?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "market_backtest_results_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "market_saved_strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      market_breadth_daily: {
        Row: {
          advances: number | null
          avg_rsi: number | null
          computed: Json | null
          computed_at: string
          declines: number | null
          dii_net_cr: number | null
          fii_net_cr: number | null
          india_vix: number | null
          market_score: number | null
          new_highs: number | null
          new_lows: number | null
          nifty_change_pct: number | null
          nifty_close: number | null
          pct_above_ema20: number | null
          pct_above_ema200: number | null
          pct_above_ema50: number | null
          regime: string | null
          trade_date: string
          unchanged: number | null
        }
        Insert: {
          advances?: number | null
          avg_rsi?: number | null
          computed?: Json | null
          computed_at?: string
          declines?: number | null
          dii_net_cr?: number | null
          fii_net_cr?: number | null
          india_vix?: number | null
          market_score?: number | null
          new_highs?: number | null
          new_lows?: number | null
          nifty_change_pct?: number | null
          nifty_close?: number | null
          pct_above_ema20?: number | null
          pct_above_ema200?: number | null
          pct_above_ema50?: number | null
          regime?: string | null
          trade_date: string
          unchanged?: number | null
        }
        Update: {
          advances?: number | null
          avg_rsi?: number | null
          computed?: Json | null
          computed_at?: string
          declines?: number | null
          dii_net_cr?: number | null
          fii_net_cr?: number | null
          india_vix?: number | null
          market_score?: number | null
          new_highs?: number | null
          new_lows?: number | null
          nifty_change_pct?: number | null
          nifty_close?: number | null
          pct_above_ema20?: number | null
          pct_above_ema200?: number | null
          pct_above_ema50?: number | null
          regime?: string | null
          trade_date?: string
          unchanged?: number | null
        }
        Relationships: []
      }
      market_breakout_snapshots: {
        Row: {
          breakout_score: number | null
          close: number | null
          components: Json | null
          computed_at: string
          exchange: string
          market_cap: number | null
          prebreakout_score: number | null
          regime: string | null
          rel_volume: number | null
          sector: string | null
          swing_score: number | null
          symbol: string
          trade_date: string
        }
        Insert: {
          breakout_score?: number | null
          close?: number | null
          components?: Json | null
          computed_at?: string
          exchange?: string
          market_cap?: number | null
          prebreakout_score?: number | null
          regime?: string | null
          rel_volume?: number | null
          sector?: string | null
          swing_score?: number | null
          symbol: string
          trade_date: string
        }
        Update: {
          breakout_score?: number | null
          close?: number | null
          components?: Json | null
          computed_at?: string
          exchange?: string
          market_cap?: number | null
          prebreakout_score?: number | null
          regime?: string | null
          rel_volume?: number | null
          sector?: string | null
          swing_score?: number | null
          symbol?: string
          trade_date?: string
        }
        Relationships: []
      }
      market_breakout_tracker: {
        Row: {
          below_threshold_days: number
          closed_at: string | null
          created_at: string
          current_close: number | null
          current_return_pct: number | null
          days_tracked: number
          detected_score: number | null
          detected_score_legacy: number | null
          entry_close: number | null
          exchange: string
          first_detected_date: string
          followthrough_score: number | null
          last_evaluated_date: string | null
          last_score: number | null
          last_score_legacy: number | null
          mae_pct: number | null
          market_cap: number | null
          peak_close: number | null
          peak_high: number | null
          peak_return_pct: number | null
          rank_pct: number | null
          score_trend: Json
          sector: string | null
          sessions_elapsed: number | null
          status: string
          symbol: string
          trigger_price: number | null
          trough_low: number | null
          updated_at: string
        }
        Insert: {
          below_threshold_days?: number
          closed_at?: string | null
          created_at?: string
          current_close?: number | null
          current_return_pct?: number | null
          days_tracked?: number
          detected_score?: number | null
          detected_score_legacy?: number | null
          entry_close?: number | null
          exchange?: string
          first_detected_date: string
          followthrough_score?: number | null
          last_evaluated_date?: string | null
          last_score?: number | null
          last_score_legacy?: number | null
          mae_pct?: number | null
          market_cap?: number | null
          peak_close?: number | null
          peak_high?: number | null
          peak_return_pct?: number | null
          rank_pct?: number | null
          score_trend?: Json
          sector?: string | null
          sessions_elapsed?: number | null
          status?: string
          symbol: string
          trigger_price?: number | null
          trough_low?: number | null
          updated_at?: string
        }
        Update: {
          below_threshold_days?: number
          closed_at?: string | null
          created_at?: string
          current_close?: number | null
          current_return_pct?: number | null
          days_tracked?: number
          detected_score?: number | null
          detected_score_legacy?: number | null
          entry_close?: number | null
          exchange?: string
          first_detected_date?: string
          followthrough_score?: number | null
          last_evaluated_date?: string | null
          last_score?: number | null
          last_score_legacy?: number | null
          mae_pct?: number | null
          market_cap?: number | null
          peak_close?: number | null
          peak_high?: number | null
          peak_return_pct?: number | null
          rank_pct?: number | null
          score_trend?: Json
          sector?: string | null
          sessions_elapsed?: number | null
          status?: string
          symbol?: string
          trigger_price?: number | null
          trough_low?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      market_daily_prices: {
        Row: {
          adj_applied_at: string | null
          adj_factor: number | null
          close: number | null
          close_adjusted: number | null
          created_at: string
          delivery_pct: number | null
          delivery_qty: number | null
          exchange: string
          high: number | null
          high_adjusted: number | null
          low: number | null
          low_adjusted: number | null
          open: number | null
          open_adjusted: number | null
          symbol: string
          trade_date: string
          volume: number | null
        }
        Insert: {
          adj_applied_at?: string | null
          adj_factor?: number | null
          close?: number | null
          close_adjusted?: number | null
          created_at?: string
          delivery_pct?: number | null
          delivery_qty?: number | null
          exchange: string
          high?: number | null
          high_adjusted?: number | null
          low?: number | null
          low_adjusted?: number | null
          open?: number | null
          open_adjusted?: number | null
          symbol: string
          trade_date: string
          volume?: number | null
        }
        Update: {
          adj_applied_at?: string | null
          adj_factor?: number | null
          close?: number | null
          close_adjusted?: number | null
          created_at?: string
          delivery_pct?: number | null
          delivery_qty?: number | null
          exchange?: string
          high?: number | null
          high_adjusted?: number | null
          low?: number | null
          low_adjusted?: number | null
          open?: number | null
          open_adjusted?: number | null
          symbol?: string
          trade_date?: string
          volume?: number | null
        }
        Relationships: []
      }
      market_eod_nse: {
        Row: {
          close: number | null
          created_at: string
          delivery_pct: number | null
          delivery_qty: number | null
          exchange: string
          fetched_at: string
          high: number | null
          low: number | null
          open: number | null
          prev_close: number | null
          series: string | null
          source: string
          source_hash: string | null
          symbol: string
          trade_date: string
          traded_value: number | null
          updated_at: string
          volume: number | null
        }
        Insert: {
          close?: number | null
          created_at?: string
          delivery_pct?: number | null
          delivery_qty?: number | null
          exchange?: string
          fetched_at?: string
          high?: number | null
          low?: number | null
          open?: number | null
          prev_close?: number | null
          series?: string | null
          source?: string
          source_hash?: string | null
          symbol: string
          trade_date: string
          traded_value?: number | null
          updated_at?: string
          volume?: number | null
        }
        Update: {
          close?: number | null
          created_at?: string
          delivery_pct?: number | null
          delivery_qty?: number | null
          exchange?: string
          fetched_at?: string
          high?: number | null
          low?: number | null
          open?: number | null
          prev_close?: number | null
          series?: string | null
          source?: string
          source_hash?: string | null
          symbol?: string
          trade_date?: string
          traded_value?: number | null
          updated_at?: string
          volume?: number | null
        }
        Relationships: []
      }
      market_excluded_symbols: {
        Row: {
          company_name: string | null
          exchange: string
          excluded_at: string
          last_close: number | null
          market_cap: number | null
          reason: string
          series: string | null
          symbol: string
        }
        Insert: {
          company_name?: string | null
          exchange?: string
          excluded_at?: string
          last_close?: number | null
          market_cap?: number | null
          reason: string
          series?: string | null
          symbol: string
        }
        Update: {
          company_name?: string | null
          exchange?: string
          excluded_at?: string
          last_close?: number | null
          market_cap?: number | null
          reason?: string
          series?: string | null
          symbol?: string
        }
        Relationships: []
      }
      market_feed_heartbeat: {
        Row: {
          detail: string | null
          feed_id: string
          latency_ms: number | null
          observed_at: string
          ok: boolean
          path: string | null
          provider: string
          symbols: number | null
        }
        Insert: {
          detail?: string | null
          feed_id: string
          latency_ms?: number | null
          observed_at?: string
          ok?: boolean
          path?: string | null
          provider: string
          symbols?: number | null
        }
        Update: {
          detail?: string | null
          feed_id?: string
          latency_ms?: number | null
          observed_at?: string
          ok?: boolean
          path?: string | null
          provider?: string
          symbols?: number | null
        }
        Relationships: []
      }
      market_feed_prefs: {
        Row: {
          created_at: string
          fallback_provider: string | null
          feed_id: string
          id: string
          provider: string
          scope: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          fallback_provider?: string | null
          feed_id: string
          id?: string
          provider: string
          scope?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          fallback_provider?: string | null
          feed_id?: string
          id?: string
          provider?: string
          scope?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      market_fundamentals: {
        Row: {
          created_at: string
          debt_to_equity: number | null
          dividend_yield: number | null
          eps_ttm: number | null
          exchange: string
          fetched_at: string
          id: string
          industry: string | null
          market_cap_cr: number | null
          payload: Json
          pb: number | null
          pe: number | null
          roce: number | null
          roe: number | null
          sector: string | null
          symbol: string
          user_id: string
        }
        Insert: {
          created_at?: string
          debt_to_equity?: number | null
          dividend_yield?: number | null
          eps_ttm?: number | null
          exchange?: string
          fetched_at?: string
          id?: string
          industry?: string | null
          market_cap_cr?: number | null
          payload: Json
          pb?: number | null
          pe?: number | null
          roce?: number | null
          roe?: number | null
          sector?: string | null
          symbol: string
          user_id?: string
        }
        Update: {
          created_at?: string
          debt_to_equity?: number | null
          dividend_yield?: number | null
          eps_ttm?: number | null
          exchange?: string
          fetched_at?: string
          id?: string
          industry?: string | null
          market_cap_cr?: number | null
          payload?: Json
          pb?: number | null
          pe?: number | null
          roce?: number | null
          roe?: number | null
          sector?: string | null
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      market_fundamentals_global: {
        Row: {
          beta: number | null
          book_value: number | null
          book_value_as_of: string | null
          book_value_source: string | null
          company_name: string | null
          current_ratio: number | null
          data_as_of: string | null
          de_as_of: string | null
          de_source: string | null
          debt_to_equity: number | null
          dii_holding: number | null
          dividend_yield: number | null
          eps_as_of: string | null
          eps_growth_yoy: number | null
          eps_source: string | null
          eps_ttm: number | null
          exchange: string
          face_value: number | null
          fii_holding: number | null
          high_52w: number | null
          industry: string | null
          last_attempted_at: string | null
          last_error: string | null
          low_52w: number | null
          market_cap_cr: number | null
          market_cap_cr_as_of: string | null
          market_cap_cr_source: string | null
          pb: number | null
          pe_as_of: string | null
          pe_source: string | null
          pe_ttm: number | null
          peg: number | null
          price: number | null
          profit_growth_yoy: number | null
          profit_ttm_cr: number | null
          promoter_holding: number | null
          promoter_pledge: number | null
          quick_ratio: number | null
          revenue_growth_yoy: number | null
          revenue_ttm_cr: number | null
          roce: number | null
          roe: number | null
          roe_as_of: string | null
          roe_source: string | null
          sector: string | null
          symbol: string
          sync_source: string | null
          sync_status: string | null
          updated_at: string
        }
        Insert: {
          beta?: number | null
          book_value?: number | null
          book_value_as_of?: string | null
          book_value_source?: string | null
          company_name?: string | null
          current_ratio?: number | null
          data_as_of?: string | null
          de_as_of?: string | null
          de_source?: string | null
          debt_to_equity?: number | null
          dii_holding?: number | null
          dividend_yield?: number | null
          eps_as_of?: string | null
          eps_growth_yoy?: number | null
          eps_source?: string | null
          eps_ttm?: number | null
          exchange?: string
          face_value?: number | null
          fii_holding?: number | null
          high_52w?: number | null
          industry?: string | null
          last_attempted_at?: string | null
          last_error?: string | null
          low_52w?: number | null
          market_cap_cr?: number | null
          market_cap_cr_as_of?: string | null
          market_cap_cr_source?: string | null
          pb?: number | null
          pe_as_of?: string | null
          pe_source?: string | null
          pe_ttm?: number | null
          peg?: number | null
          price?: number | null
          profit_growth_yoy?: number | null
          profit_ttm_cr?: number | null
          promoter_holding?: number | null
          promoter_pledge?: number | null
          quick_ratio?: number | null
          revenue_growth_yoy?: number | null
          revenue_ttm_cr?: number | null
          roce?: number | null
          roe?: number | null
          roe_as_of?: string | null
          roe_source?: string | null
          sector?: string | null
          symbol: string
          sync_source?: string | null
          sync_status?: string | null
          updated_at?: string
        }
        Update: {
          beta?: number | null
          book_value?: number | null
          book_value_as_of?: string | null
          book_value_source?: string | null
          company_name?: string | null
          current_ratio?: number | null
          data_as_of?: string | null
          de_as_of?: string | null
          de_source?: string | null
          debt_to_equity?: number | null
          dii_holding?: number | null
          dividend_yield?: number | null
          eps_as_of?: string | null
          eps_growth_yoy?: number | null
          eps_source?: string | null
          eps_ttm?: number | null
          exchange?: string
          face_value?: number | null
          fii_holding?: number | null
          high_52w?: number | null
          industry?: string | null
          last_attempted_at?: string | null
          last_error?: string | null
          low_52w?: number | null
          market_cap_cr?: number | null
          market_cap_cr_as_of?: string | null
          market_cap_cr_source?: string | null
          pb?: number | null
          pe_as_of?: string | null
          pe_source?: string | null
          pe_ttm?: number | null
          peg?: number | null
          price?: number | null
          profit_growth_yoy?: number | null
          profit_ttm_cr?: number | null
          promoter_holding?: number | null
          promoter_pledge?: number | null
          quick_ratio?: number | null
          revenue_growth_yoy?: number | null
          revenue_ttm_cr?: number | null
          roce?: number | null
          roe?: number | null
          roe_as_of?: string | null
          roe_source?: string | null
          sector?: string | null
          symbol?: string
          sync_source?: string | null
          sync_status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      market_fundamentals_provenance: {
        Row: {
          created_at: string
          data_as_of: string | null
          exchange: string
          fetched_at: string
          field_name: string
          id: string
          source: string
          source_url: string | null
          symbol: string
          updated_at: string
          value: number | null
        }
        Insert: {
          created_at?: string
          data_as_of?: string | null
          exchange?: string
          fetched_at?: string
          field_name: string
          id?: string
          source: string
          source_url?: string | null
          symbol: string
          updated_at?: string
          value?: number | null
        }
        Update: {
          created_at?: string
          data_as_of?: string | null
          exchange?: string
          fetched_at?: string
          field_name?: string
          id?: string
          source?: string
          source_url?: string | null
          symbol?: string
          updated_at?: string
          value?: number | null
        }
        Relationships: []
      }
      market_funds: {
        Row: {
          available_margin: number | null
          collateral: number | null
          created_at: string
          net_cash: number | null
          payin_amount: number | null
          payload: Json | null
          synced_at: string
          updated_at: string
          used_margin: number | null
          user_id: string
        }
        Insert: {
          available_margin?: number | null
          collateral?: number | null
          created_at?: string
          net_cash?: number | null
          payin_amount?: number | null
          payload?: Json | null
          synced_at?: string
          updated_at?: string
          used_margin?: number | null
          user_id?: string
        }
        Update: {
          available_margin?: number | null
          collateral?: number | null
          created_at?: string
          net_cash?: number | null
          payin_amount?: number | null
          payload?: Json | null
          synced_at?: string
          updated_at?: string
          used_margin?: number | null
          user_id?: string
        }
        Relationships: []
      }
      market_gtt_orders: {
        Row: {
          broker_order_id: string | null
          created_at: string
          exchange: string
          expires_at: string | null
          id: string
          last_error: string | null
          notes: string | null
          order_type: string
          price: number | null
          product: string
          quantity: number
          side: string
          status: string
          symbol: string
          trigger_price: number
          trigger_price_upper: number | null
          trigger_type: string
          triggered_at: string | null
          triggered_leg: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          broker_order_id?: string | null
          created_at?: string
          exchange?: string
          expires_at?: string | null
          id?: string
          last_error?: string | null
          notes?: string | null
          order_type?: string
          price?: number | null
          product?: string
          quantity: number
          side: string
          status?: string
          symbol: string
          trigger_price: number
          trigger_price_upper?: number | null
          trigger_type?: string
          triggered_at?: string | null
          triggered_leg?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          broker_order_id?: string | null
          created_at?: string
          exchange?: string
          expires_at?: string | null
          id?: string
          last_error?: string | null
          notes?: string | null
          order_type?: string
          price?: number | null
          product?: string
          quantity?: number
          side?: string
          status?: string
          symbol?: string
          trigger_price?: number
          trigger_price_upper?: number | null
          trigger_type?: string
          triggered_at?: string | null
          triggered_leg?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_holdings: {
        Row: {
          avg_price: number
          buy_date: string | null
          created_at: string
          exchange: string
          external_id: string | null
          id: string
          investment_type: string | null
          notes: string | null
          pledged_qty: number | null
          quantity: number
          settled_qty: number | null
          source: Database["public"]["Enums"]["market_holding_source"]
          symbol: string
          t1_qty: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          avg_price: number
          buy_date?: string | null
          created_at?: string
          exchange?: string
          external_id?: string | null
          id?: string
          investment_type?: string | null
          notes?: string | null
          pledged_qty?: number | null
          quantity: number
          settled_qty?: number | null
          source?: Database["public"]["Enums"]["market_holding_source"]
          symbol: string
          t1_qty?: number | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          avg_price?: number
          buy_date?: string | null
          created_at?: string
          exchange?: string
          external_id?: string | null
          id?: string
          investment_type?: string | null
          notes?: string | null
          pledged_qty?: number | null
          quantity?: number
          settled_qty?: number | null
          source?: Database["public"]["Enums"]["market_holding_source"]
          symbol?: string
          t1_qty?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_holidays: {
        Row: {
          created_at: string
          description: string | null
          exchange: string
          holiday_date: string
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          exchange?: string
          holiday_date: string
          id?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          exchange?: string
          holiday_date?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      market_index_members: {
        Row: {
          exchange: string
          index_key: string
          rank: number | null
          symbol: string
          updated_at: string
          weight: number | null
        }
        Insert: {
          exchange?: string
          index_key: string
          rank?: number | null
          symbol: string
          updated_at?: string
          weight?: number | null
        }
        Update: {
          exchange?: string
          index_key?: string
          rank?: number | null
          symbol?: string
          updated_at?: string
          weight?: number | null
        }
        Relationships: []
      }
      market_index_watch: {
        Row: {
          constituents_slug: string | null
          created_at: string
          fno_enabled: boolean
          id: string
          name: string
          nse_symbol: string | null
          region: string
          sort_order: number
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          constituents_slug?: string | null
          created_at?: string
          fno_enabled?: boolean
          id?: string
          name: string
          nse_symbol?: string | null
          region: string
          sort_order?: number
          symbol: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          constituents_slug?: string | null
          created_at?: string
          fno_enabled?: boolean
          id?: string
          name?: string
          nse_symbol?: string | null
          region?: string
          sort_order?: number
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_indicators_cache: {
        Row: {
          computed_at: string
          exchange: string
          id: string
          indicator: string
          symbol: string
          timeframe: string
          value: Json
        }
        Insert: {
          computed_at?: string
          exchange?: string
          id?: string
          indicator: string
          symbol: string
          timeframe: string
          value: Json
        }
        Update: {
          computed_at?: string
          exchange?: string
          id?: string
          indicator?: string
          symbol?: string
          timeframe?: string
          value?: Json
        }
        Relationships: []
      }
      market_ingestion_runs: {
        Row: {
          duration_ms: number | null
          error_message: string | null
          finished_at: string | null
          id: string
          metadata: Json | null
          rows_ingested: number | null
          source: string
          stage: string
          started_at: string
          status: string
          trade_date: string | null
        }
        Insert: {
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          metadata?: Json | null
          rows_ingested?: number | null
          source: string
          stage: string
          started_at?: string
          status: string
          trade_date?: string | null
        }
        Update: {
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          metadata?: Json | null
          rows_ingested?: number | null
          source?: string
          stage?: string
          started_at?: string
          status?: string
          trade_date?: string | null
        }
        Relationships: []
      }
      market_intraday_prices: {
        Row: {
          close: number | null
          created_at: string
          cum_volume: number | null
          exchange: string
          fetched_at: string
          high: number | null
          id: string
          low: number | null
          open: number | null
          source: string | null
          symbol: string
          timeframe: string
          ts: string
          volume: number | null
        }
        Insert: {
          close?: number | null
          created_at?: string
          cum_volume?: number | null
          exchange: string
          fetched_at?: string
          high?: number | null
          id?: string
          low?: number | null
          open?: number | null
          source?: string | null
          symbol: string
          timeframe?: string
          ts: string
          volume?: number | null
        }
        Update: {
          close?: number | null
          created_at?: string
          cum_volume?: number | null
          exchange?: string
          fetched_at?: string
          high?: number | null
          id?: string
          low?: number | null
          open?: number | null
          source?: string | null
          symbol?: string
          timeframe?: string
          ts?: string
          volume?: number | null
        }
        Relationships: []
      }
      market_live_price_runs: {
        Row: {
          as_of: string
          completed_at: string | null
          error_message: string | null
          expected_count: number
          failed_count: number
          kotak_count: number
          last_symbol: string | null
          priced_count: number
          scanned_count: number
          session_date: string
          started_at: string
          status: string
          sweep_id: string
          updated_at: string
          yahoo_count: number
        }
        Insert: {
          as_of: string
          completed_at?: string | null
          error_message?: string | null
          expected_count?: number
          failed_count?: number
          kotak_count?: number
          last_symbol?: string | null
          priced_count?: number
          scanned_count?: number
          session_date: string
          started_at?: string
          status?: string
          sweep_id: string
          updated_at?: string
          yahoo_count?: number
        }
        Update: {
          as_of?: string
          completed_at?: string | null
          error_message?: string | null
          expected_count?: number
          failed_count?: number
          kotak_count?: number
          last_symbol?: string | null
          priced_count?: number
          scanned_count?: number
          session_date?: string
          started_at?: string
          status?: string
          sweep_id?: string
          updated_at?: string
          yahoo_count?: number
        }
        Relationships: []
      }
      market_live_price_stage: {
        Row: {
          as_of: string
          change_abs: number | null
          change_pct: number | null
          created_at: string
          exchange: string
          ltp: number | null
          market_cap_live: number | null
          prev_close: number | null
          provider: string | null
          quote_rejected: boolean
          reject_reason: string | null
          session_date: string
          sweep_id: string
          symbol: string
          volume: number | null
        }
        Insert: {
          as_of: string
          change_abs?: number | null
          change_pct?: number | null
          created_at?: string
          exchange?: string
          ltp?: number | null
          market_cap_live?: number | null
          prev_close?: number | null
          provider?: string | null
          quote_rejected?: boolean
          reject_reason?: string | null
          session_date: string
          sweep_id: string
          symbol: string
          volume?: number | null
        }
        Update: {
          as_of?: string
          change_abs?: number | null
          change_pct?: number | null
          created_at?: string
          exchange?: string
          ltp?: number | null
          market_cap_live?: number | null
          prev_close?: number | null
          provider?: string | null
          quote_rejected?: boolean
          reject_reason?: string | null
          session_date?: string
          sweep_id?: string
          symbol?: string
          volume?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "market_live_price_stage_sweep_id_fkey"
            columns: ["sweep_id"]
            isOneToOne: false
            referencedRelation: "market_live_price_runs"
            referencedColumns: ["sweep_id"]
          },
          {
            foreignKeyName: "market_live_price_stage_sweep_id_fkey"
            columns: ["sweep_id"]
            isOneToOne: false
            referencedRelation: "market_live_price_status"
            referencedColumns: ["sweep_id"]
          },
        ]
      }
      market_live_prices: {
        Row: {
          as_of: string
          change_abs: number | null
          change_pct: number | null
          exchange: string
          ltp: number | null
          market_cap_live: number | null
          prev_close: number | null
          provider: string | null
          quote_rejected: boolean
          reject_reason: string | null
          session_date: string
          sweep_id: string | null
          symbol: string
          updated_at: string
          volume: number | null
        }
        Insert: {
          as_of?: string
          change_abs?: number | null
          change_pct?: number | null
          exchange?: string
          ltp?: number | null
          market_cap_live?: number | null
          prev_close?: number | null
          provider?: string | null
          quote_rejected?: boolean
          reject_reason?: string | null
          session_date: string
          sweep_id?: string | null
          symbol: string
          updated_at?: string
          volume?: number | null
        }
        Update: {
          as_of?: string
          change_abs?: number | null
          change_pct?: number | null
          exchange?: string
          ltp?: number | null
          market_cap_live?: number | null
          prev_close?: number | null
          provider?: string | null
          quote_rejected?: boolean
          reject_reason?: string | null
          session_date?: string
          sweep_id?: string | null
          symbol?: string
          updated_at?: string
          volume?: number | null
        }
        Relationships: []
      }
      market_metric_consensus: {
        Row: {
          computed_at: string
          confidence: number
          created_at: string
          delta_pct: number | null
          exchange: string
          metric: string
          notes: string | null
          provider_as_of: string | null
          ref_value: number | null
          source_method: string
          source_provider: string
          status: string
          symbol: string
          unit: string | null
          updated_at: string
          value: number | null
        }
        Insert: {
          computed_at?: string
          confidence?: number
          created_at?: string
          delta_pct?: number | null
          exchange?: string
          metric: string
          notes?: string | null
          provider_as_of?: string | null
          ref_value?: number | null
          source_method: string
          source_provider: string
          status?: string
          symbol: string
          unit?: string | null
          updated_at?: string
          value?: number | null
        }
        Update: {
          computed_at?: string
          confidence?: number
          created_at?: string
          delta_pct?: number | null
          exchange?: string
          metric?: string
          notes?: string | null
          provider_as_of?: string | null
          ref_value?: number | null
          source_method?: string
          source_provider?: string
          status?: string
          symbol?: string
          unit?: string | null
          updated_at?: string
          value?: number | null
        }
        Relationships: []
      }
      market_news: {
        Row: {
          classified_at: string | null
          created_at: string
          exchange: string
          headline: string
          id: string
          impact: string | null
          published_at: string
          sentiment: number | null
          source: string | null
          symbol: string | null
          url: string | null
        }
        Insert: {
          classified_at?: string | null
          created_at?: string
          exchange?: string
          headline: string
          id?: string
          impact?: string | null
          published_at?: string
          sentiment?: number | null
          source?: string | null
          symbol?: string | null
          url?: string | null
        }
        Update: {
          classified_at?: string | null
          created_at?: string
          exchange?: string
          headline?: string
          id?: string
          impact?: string | null
          published_at?: string
          sentiment?: number | null
          source?: string | null
          symbol?: string | null
          url?: string | null
        }
        Relationships: []
      }
      market_nse_master: {
        Row: {
          company_name: string | null
          created_at: string
          face_value: number | null
          fetched_at: string
          is_active: boolean
          isin: string | null
          listing_date: string | null
          series: string | null
          symbol: string
          updated_at: string
        }
        Insert: {
          company_name?: string | null
          created_at?: string
          face_value?: number | null
          fetched_at?: string
          is_active?: boolean
          isin?: string | null
          listing_date?: string | null
          series?: string | null
          symbol: string
          updated_at?: string
        }
        Update: {
          company_name?: string | null
          created_at?: string
          face_value?: number | null
          fetched_at?: string
          is_active?: boolean
          isin?: string | null
          listing_date?: string | null
          series?: string | null
          symbol?: string
          updated_at?: string
        }
        Relationships: []
      }
      market_option_chain_snapshots: {
        Row: {
          captured_at: string
          expiry: string
          id: string
          payload: Json
          symbol: string
          underlying_price: number | null
          user_id: string
        }
        Insert: {
          captured_at?: string
          expiry: string
          id?: string
          payload: Json
          symbol: string
          underlying_price?: number | null
          user_id?: string
        }
        Update: {
          captured_at?: string
          expiry?: string
          id?: string
          payload?: Json
          symbol?: string
          underlying_price?: number | null
          user_id?: string
        }
        Relationships: []
      }
      market_order_intents: {
        Row: {
          broker_order_id: string | null
          broker_status: string | null
          created_at: string
          error: string | null
          id: string
          idempotency_key: string
          request: Json
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          broker_order_id?: string | null
          broker_status?: string | null
          created_at?: string
          error?: string | null
          id?: string
          idempotency_key: string
          request: Json
          status?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          broker_order_id?: string | null
          broker_status?: string | null
          created_at?: string
          error?: string | null
          id?: string
          idempotency_key?: string
          request?: Json
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_portfolio_notes: {
        Row: {
          created_at: string
          id: string
          note: string
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          note: string
          symbol: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          note?: string
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_positions: {
        Row: {
          closed_at: string | null
          created_at: string
          entry_price: number
          exchange: string
          exit_price: number | null
          exit_source: string | null
          id: string
          is_broker_synced: boolean
          journal_notes: string | null
          opened_at: string
          pnl: number | null
          product: string | null
          quantity: number
          side: Database["public"]["Enums"]["market_position_side"]
          stop_loss: number | null
          symbol: string
          target: number | null
          trailing_stop: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          entry_price: number
          exchange?: string
          exit_price?: number | null
          exit_source?: string | null
          id?: string
          is_broker_synced?: boolean
          journal_notes?: string | null
          opened_at?: string
          pnl?: number | null
          product?: string | null
          quantity: number
          side?: Database["public"]["Enums"]["market_position_side"]
          stop_loss?: number | null
          symbol: string
          target?: number | null
          trailing_stop?: number | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          entry_price?: number
          exchange?: string
          exit_price?: number | null
          exit_source?: string | null
          id?: string
          is_broker_synced?: boolean
          journal_notes?: string | null
          opened_at?: string
          pnl?: number | null
          product?: string | null
          quantity?: number
          side?: Database["public"]["Enums"]["market_position_side"]
          stop_loss?: number | null
          symbol?: string
          target?: number | null
          trailing_stop?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_provider_credentials: {
        Row: {
          api_key_enc: Json | null
          created_at: string
          key_hint: string | null
          key_set: boolean
          last_test_detail: string | null
          last_test_ok: boolean | null
          last_tested_at: string | null
          provider: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          api_key_enc?: Json | null
          created_at?: string
          key_hint?: string | null
          key_set?: boolean
          last_test_detail?: string | null
          last_test_ok?: boolean | null
          last_tested_at?: string | null
          provider: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          api_key_enc?: Json | null
          created_at?: string
          key_hint?: string | null
          key_set?: boolean
          last_test_detail?: string | null
          last_test_ok?: boolean | null
          last_tested_at?: string | null
          provider?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      market_provider_health: {
        Row: {
          created_at: string
          endpoint: string
          error: string | null
          id: string
          latency_ms: number | null
          ok: boolean
          provider: string
        }
        Insert: {
          created_at?: string
          endpoint: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          ok: boolean
          provider: string
        }
        Update: {
          created_at?: string
          endpoint?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          ok?: boolean
          provider?: string
        }
        Relationships: []
      }
      market_provider_observations: {
        Row: {
          confidence: number
          created_at: string
          exchange: string
          fetched_at: string
          id: string
          metric: string
          notes: string | null
          provider: string
          provider_as_of: string | null
          raw_payload: Json | null
          raw_payload_hash: string | null
          source_method: string | null
          status: string
          symbol: string
          unit: string | null
          updated_at: string
          value: number | null
        }
        Insert: {
          confidence?: number
          created_at?: string
          exchange?: string
          fetched_at?: string
          id?: string
          metric: string
          notes?: string | null
          provider: string
          provider_as_of?: string | null
          raw_payload?: Json | null
          raw_payload_hash?: string | null
          source_method?: string | null
          status?: string
          symbol: string
          unit?: string | null
          updated_at?: string
          value?: number | null
        }
        Update: {
          confidence?: number
          created_at?: string
          exchange?: string
          fetched_at?: string
          id?: string
          metric?: string
          notes?: string | null
          provider?: string
          provider_as_of?: string | null
          raw_payload?: Json | null
          raw_payload_hash?: string | null
          source_method?: string | null
          status?: string
          symbol?: string
          unit?: string | null
          updated_at?: string
          value?: number | null
        }
        Relationships: []
      }
      market_quotes: {
        Row: {
          change_abs: number | null
          change_pct: number | null
          currency: string
          fetched_at: string
          kind: string
          name: string
          price: number
          source: string
          symbol: string
          updated_at: string
        }
        Insert: {
          change_abs?: number | null
          change_pct?: number | null
          currency?: string
          fetched_at?: string
          kind: string
          name: string
          price: number
          source?: string
          symbol: string
          updated_at?: string
        }
        Update: {
          change_abs?: number | null
          change_pct?: number | null
          currency?: string
          fetched_at?: string
          kind?: string
          name?: string
          price?: number
          source?: string
          symbol?: string
          updated_at?: string
        }
        Relationships: []
      }
      market_realized_pnl_daily: {
        Row: {
          created_at: string
          day: string
          exchange: string
          id: string
          quantity: number
          realized: number
          source: string
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          day: string
          exchange: string
          id?: string
          quantity: number
          realized: number
          source?: string
          symbol: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          day?: string
          exchange?: string
          id?: string
          quantity?: number
          realized?: number
          source?: string
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_reference_audit_runs: {
        Row: {
          created_at: string
          finished_at: string | null
          id: string
          metadata: Json
          mismatches: number
          mode: string
          source: string
          started_at: string
          status: string
          symbols_checked: number
          symbols_requested: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          finished_at?: string | null
          id?: string
          metadata?: Json
          mismatches?: number
          mode?: string
          source?: string
          started_at?: string
          status?: string
          symbols_checked?: number
          symbols_requested?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          finished_at?: string | null
          id?: string
          metadata?: Json
          mismatches?: number
          mode?: string
          source?: string
          started_at?: string
          status?: string
          symbols_checked?: number
          symbols_requested?: number
          updated_at?: string
        }
        Relationships: []
      }
      market_route_health: {
        Row: {
          failures: number
          last_error: string | null
          open_until: string | null
          opened_at: string | null
          route: string
          updated_at: string
        }
        Insert: {
          failures?: number
          last_error?: string | null
          open_until?: string | null
          opened_at?: string | null
          route: string
          updated_at?: string
        }
        Update: {
          failures?: number
          last_error?: string | null
          open_until?: string | null
          opened_at?: string | null
          route?: string
          updated_at?: string
        }
        Relationships: []
      }
      market_saved_screeners: {
        Row: {
          created_at: string
          description: string | null
          filters: Json
          id: string
          name: string
          scope: string
          sort: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          filters?: Json
          id?: string
          name: string
          scope?: string
          sort?: Json | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          filters?: Json
          id?: string
          name?: string
          scope?: string
          sort?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_saved_strategies: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          strategy: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          strategy: Json
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          strategy?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_score_distribution: {
        Row: {
          created_at: string
          id: string
          max: number | null
          model: string
          moderate_cut: number | null
          n: number
          p50: number | null
          p70: number | null
          p90: number | null
          strong_cut: number | null
          trade_date: string
          updated_at: string
          watch_cut: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          max?: number | null
          model?: string
          moderate_cut?: number | null
          n?: number
          p50?: number | null
          p70?: number | null
          p90?: number | null
          strong_cut?: number | null
          trade_date: string
          updated_at?: string
          watch_cut?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          max?: number | null
          model?: string
          moderate_cut?: number | null
          n?: number
          p50?: number | null
          p70?: number | null
          p90?: number | null
          strong_cut?: number | null
          trade_date?: string
          updated_at?: string
          watch_cut?: number | null
        }
        Relationships: []
      }
      market_score_history: {
        Row: {
          band: string | null
          buckets: Json | null
          close: number | null
          context_neutral: boolean
          coverage: Json | null
          created_at: string
          evaluated_at: string | null
          exchange: string
          fwd_rel_10d: number | null
          fwd_rel_21d: number | null
          fwd_rel_5d: number | null
          fwd_ret_10d: number | null
          fwd_ret_21d: number | null
          fwd_ret_5d: number | null
          id: string
          is_liquid_tradable: boolean | null
          model: string
          rank_pct: number | null
          raw_buckets: Json | null
          score: number | null
          symbol: string
          trade_date: string
        }
        Insert: {
          band?: string | null
          buckets?: Json | null
          close?: number | null
          context_neutral?: boolean
          coverage?: Json | null
          created_at?: string
          evaluated_at?: string | null
          exchange?: string
          fwd_rel_10d?: number | null
          fwd_rel_21d?: number | null
          fwd_rel_5d?: number | null
          fwd_ret_10d?: number | null
          fwd_ret_21d?: number | null
          fwd_ret_5d?: number | null
          id?: string
          is_liquid_tradable?: boolean | null
          model?: string
          rank_pct?: number | null
          raw_buckets?: Json | null
          score?: number | null
          symbol: string
          trade_date: string
        }
        Update: {
          band?: string | null
          buckets?: Json | null
          close?: number | null
          context_neutral?: boolean
          coverage?: Json | null
          created_at?: string
          evaluated_at?: string | null
          exchange?: string
          fwd_rel_10d?: number | null
          fwd_rel_21d?: number | null
          fwd_rel_5d?: number | null
          fwd_ret_10d?: number | null
          fwd_ret_21d?: number | null
          fwd_ret_5d?: number | null
          id?: string
          is_liquid_tradable?: boolean | null
          model?: string
          rank_pct?: number | null
          raw_buckets?: Json | null
          score?: number | null
          symbol?: string
          trade_date?: string
        }
        Relationships: []
      }
      market_score_model_versions: {
        Row: {
          band_cuts: Json | null
          created_at: string
          id: string
          is_active: boolean
          model: string
          notes: string | null
          source_run_id: string | null
          updated_at: string
          weights: Json
        }
        Insert: {
          band_cuts?: Json | null
          created_at?: string
          id?: string
          is_active?: boolean
          model: string
          notes?: string | null
          source_run_id?: string | null
          updated_at?: string
          weights: Json
        }
        Update: {
          band_cuts?: Json | null
          created_at?: string
          id?: string
          is_active?: boolean
          model?: string
          notes?: string | null
          source_run_id?: string | null
          updated_at?: string
          weights?: Json
        }
        Relationships: []
      }
      market_score_optimizer_runs: {
        Row: {
          baseline: Json | null
          best: Json | null
          candidates: Json
          created_at: string
          created_by: string | null
          id: string
          model: string
          params: Json
          sample_n: number | null
        }
        Insert: {
          baseline?: Json | null
          best?: Json | null
          candidates?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          model?: string
          params?: Json
          sample_n?: number | null
        }
        Update: {
          baseline?: Json | null
          best?: Json | null
          candidates?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          model?: string
          params?: Json
          sample_n?: number | null
        }
        Relationships: []
      }
      market_scoring_calibration: {
        Row: {
          as_of_date: string | null
          component: string
          computed_at: string
          id: string
          kind: string
          meta: Json | null
          model: string | null
          model_version: string
          r2: number | null
          sample_n: number | null
          weight: number
        }
        Insert: {
          as_of_date?: string | null
          component: string
          computed_at?: string
          id?: string
          kind?: string
          meta?: Json | null
          model?: string | null
          model_version: string
          r2?: number | null
          sample_n?: number | null
          weight: number
        }
        Update: {
          as_of_date?: string | null
          component?: string
          computed_at?: string
          id?: string
          kind?: string
          meta?: Json | null
          model?: string | null
          model_version?: string
          r2?: number | null
          sample_n?: number | null
          weight?: number
        }
        Relationships: []
      }
      market_screener_favorites: {
        Row: {
          created_at: string
          filter_id: string
          id: string
          sort_order: number
          user_id: string
        }
        Insert: {
          created_at?: string
          filter_id: string
          id?: string
          sort_order?: number
          user_id?: string
        }
        Update: {
          created_at?: string
          filter_id?: string
          id?: string
          sort_order?: number
          user_id?: string
        }
        Relationships: []
      }
      market_screener_snapshot: {
        Row: {
          above_ema200: boolean | null
          adx14: number | null
          atr_pct: number | null
          atr14: number | null
          bb_lower: number | null
          bb_squeeze: boolean | null
          bb_upper: number | null
          bb_width: number | null
          book_value: number | null
          breakout_score: number | null
          change_abs: number | null
          change_pct: number | null
          change_pct_raw: number | null
          close: number | null
          close_adjusted: number | null
          company_name: string | null
          computed_at: string | null
          current_ratio: number | null
          data_as_of: string | null
          data_provenance: Json | null
          debt_to_equity: number | null
          dii_holding: number | null
          dividend_yield: number | null
          ema100: number | null
          ema20: number | null
          ema200: number | null
          ema50: number | null
          eps_growth_yoy: number | null
          eps_ttm: number | null
          exchange: string | null
          face_value: number | null
          fii_holding: number | null
          fno_enabled: boolean | null
          fundamental_high_52w: number | null
          fundamental_low_52w: number | null
          fundamental_price: number | null
          fundamentals_updated_at: string | null
          high_52w: number | null
          higher_lows: boolean | null
          in_universe: boolean | null
          industry: string | null
          instrument_type: string | null
          intraday_score: number | null
          is_active: boolean | null
          is_liquid_tradable: boolean | null
          is_nifty500: boolean | null
          last_attempted_at: string | null
          last_error: string | null
          last_fundamentals_sync_at: string | null
          last_price_sync_at: string | null
          liquidity_reasons: Json | null
          low_52w: number | null
          macd: number | null
          macd_hist: number | null
          macd_signal: number | null
          market_cap: number | null
          market_cap_reported: number | null
          near_resistance: boolean | null
          pb: number | null
          pct_from_52w_high: number | null
          pe_ttm: number | null
          peg: number | null
          prebreakout_score: number | null
          previous_close: number | null
          profit_growth_yoy: number | null
          profit_ttm_cr: number | null
          promoter_holding: number | null
          promoter_pledge: number | null
          quick_ratio: number | null
          refreshed_at: string | null
          rel_strength_nifty: number | null
          rel_volume: number | null
          resistance_level: number | null
          ret_21d: number | null
          ret_5d: number | null
          ret_ytd: number | null
          revenue_growth_yoy: number | null
          revenue_ttm_cr: number | null
          roce: number | null
          roe: number | null
          rsi14: number | null
          score_components: Json | null
          score_id: string | null
          score_trade_date: string | null
          sector: string | null
          sector_strength: number | null
          sme: boolean | null
          strict_ok: boolean | null
          sub_sector: string | null
          support_level: number | null
          swing_score: number | null
          symbol: string | null
          sync_source: string | null
          sync_status: string | null
          trade_date: string | null
          vol_avg20: number | null
          vol_avg30: number | null
          vol_gt_avg30: boolean | null
          volume: number | null
          yahoo_symbol: string | null
        }
        Insert: {
          above_ema200?: boolean | null
          adx14?: number | null
          atr_pct?: number | null
          atr14?: number | null
          bb_lower?: number | null
          bb_squeeze?: boolean | null
          bb_upper?: number | null
          bb_width?: number | null
          book_value?: number | null
          breakout_score?: number | null
          change_abs?: number | null
          change_pct?: number | null
          change_pct_raw?: number | null
          close?: number | null
          close_adjusted?: number | null
          company_name?: string | null
          computed_at?: string | null
          current_ratio?: number | null
          data_as_of?: string | null
          data_provenance?: Json | null
          debt_to_equity?: number | null
          dii_holding?: number | null
          dividend_yield?: number | null
          ema100?: number | null
          ema20?: number | null
          ema200?: number | null
          ema50?: number | null
          eps_growth_yoy?: number | null
          eps_ttm?: number | null
          exchange?: string | null
          face_value?: number | null
          fii_holding?: number | null
          fno_enabled?: boolean | null
          fundamental_high_52w?: number | null
          fundamental_low_52w?: number | null
          fundamental_price?: number | null
          fundamentals_updated_at?: string | null
          high_52w?: number | null
          higher_lows?: boolean | null
          in_universe?: boolean | null
          industry?: string | null
          instrument_type?: string | null
          intraday_score?: number | null
          is_active?: boolean | null
          is_liquid_tradable?: boolean | null
          is_nifty500?: boolean | null
          last_attempted_at?: string | null
          last_error?: string | null
          last_fundamentals_sync_at?: string | null
          last_price_sync_at?: string | null
          liquidity_reasons?: Json | null
          low_52w?: number | null
          macd?: number | null
          macd_hist?: number | null
          macd_signal?: number | null
          market_cap?: number | null
          market_cap_reported?: number | null
          near_resistance?: boolean | null
          pb?: number | null
          pct_from_52w_high?: number | null
          pe_ttm?: number | null
          peg?: number | null
          prebreakout_score?: number | null
          previous_close?: number | null
          profit_growth_yoy?: number | null
          profit_ttm_cr?: number | null
          promoter_holding?: number | null
          promoter_pledge?: number | null
          quick_ratio?: number | null
          refreshed_at?: string | null
          rel_strength_nifty?: number | null
          rel_volume?: number | null
          resistance_level?: number | null
          ret_21d?: number | null
          ret_5d?: number | null
          ret_ytd?: number | null
          revenue_growth_yoy?: number | null
          revenue_ttm_cr?: number | null
          roce?: number | null
          roe?: number | null
          rsi14?: number | null
          score_components?: Json | null
          score_id?: string | null
          score_trade_date?: string | null
          sector?: string | null
          sector_strength?: number | null
          sme?: boolean | null
          strict_ok?: boolean | null
          sub_sector?: string | null
          support_level?: number | null
          swing_score?: number | null
          symbol?: string | null
          sync_source?: string | null
          sync_status?: string | null
          trade_date?: string | null
          vol_avg20?: number | null
          vol_avg30?: number | null
          vol_gt_avg30?: boolean | null
          volume?: number | null
          yahoo_symbol?: string | null
        }
        Update: {
          above_ema200?: boolean | null
          adx14?: number | null
          atr_pct?: number | null
          atr14?: number | null
          bb_lower?: number | null
          bb_squeeze?: boolean | null
          bb_upper?: number | null
          bb_width?: number | null
          book_value?: number | null
          breakout_score?: number | null
          change_abs?: number | null
          change_pct?: number | null
          change_pct_raw?: number | null
          close?: number | null
          close_adjusted?: number | null
          company_name?: string | null
          computed_at?: string | null
          current_ratio?: number | null
          data_as_of?: string | null
          data_provenance?: Json | null
          debt_to_equity?: number | null
          dii_holding?: number | null
          dividend_yield?: number | null
          ema100?: number | null
          ema20?: number | null
          ema200?: number | null
          ema50?: number | null
          eps_growth_yoy?: number | null
          eps_ttm?: number | null
          exchange?: string | null
          face_value?: number | null
          fii_holding?: number | null
          fno_enabled?: boolean | null
          fundamental_high_52w?: number | null
          fundamental_low_52w?: number | null
          fundamental_price?: number | null
          fundamentals_updated_at?: string | null
          high_52w?: number | null
          higher_lows?: boolean | null
          in_universe?: boolean | null
          industry?: string | null
          instrument_type?: string | null
          intraday_score?: number | null
          is_active?: boolean | null
          is_liquid_tradable?: boolean | null
          is_nifty500?: boolean | null
          last_attempted_at?: string | null
          last_error?: string | null
          last_fundamentals_sync_at?: string | null
          last_price_sync_at?: string | null
          liquidity_reasons?: Json | null
          low_52w?: number | null
          macd?: number | null
          macd_hist?: number | null
          macd_signal?: number | null
          market_cap?: number | null
          market_cap_reported?: number | null
          near_resistance?: boolean | null
          pb?: number | null
          pct_from_52w_high?: number | null
          pe_ttm?: number | null
          peg?: number | null
          prebreakout_score?: number | null
          previous_close?: number | null
          profit_growth_yoy?: number | null
          profit_ttm_cr?: number | null
          promoter_holding?: number | null
          promoter_pledge?: number | null
          quick_ratio?: number | null
          refreshed_at?: string | null
          rel_strength_nifty?: number | null
          rel_volume?: number | null
          resistance_level?: number | null
          ret_21d?: number | null
          ret_5d?: number | null
          ret_ytd?: number | null
          revenue_growth_yoy?: number | null
          revenue_ttm_cr?: number | null
          roce?: number | null
          roe?: number | null
          rsi14?: number | null
          score_components?: Json | null
          score_id?: string | null
          score_trade_date?: string | null
          sector?: string | null
          sector_strength?: number | null
          sme?: boolean | null
          strict_ok?: boolean | null
          sub_sector?: string | null
          support_level?: number | null
          swing_score?: number | null
          symbol?: string | null
          sync_source?: string | null
          sync_status?: string | null
          trade_date?: string | null
          vol_avg20?: number | null
          vol_avg30?: number | null
          vol_gt_avg30?: boolean | null
          volume?: number | null
          yahoo_symbol?: string | null
        }
        Relationships: []
      }
      market_sector_map: {
        Row: {
          industry: string
          nse_sector: string
          source: string
          sub_sector: string
          updated_at: string
        }
        Insert: {
          industry?: string
          nse_sector: string
          source?: string
          sub_sector: string
          updated_at?: string
        }
        Update: {
          industry?: string
          nse_sector?: string
          source?: string
          sub_sector?: string
          updated_at?: string
        }
        Relationships: []
      }
      market_sector_strength_daily: {
        Row: {
          avg_change_pct: number | null
          avg_ret_21d: number | null
          avg_ret_5d: number | null
          avg_rsi: number | null
          blended_strength: number | null
          computed_at: string
          id: string
          participation_delta: number | null
          pct_above_ema50: number | null
          sector: string
          stock_count: number | null
          strength_rank: number | null
          trade_date: string
        }
        Insert: {
          avg_change_pct?: number | null
          avg_ret_21d?: number | null
          avg_ret_5d?: number | null
          avg_rsi?: number | null
          blended_strength?: number | null
          computed_at?: string
          id?: string
          participation_delta?: number | null
          pct_above_ema50?: number | null
          sector: string
          stock_count?: number | null
          strength_rank?: number | null
          trade_date: string
        }
        Update: {
          avg_change_pct?: number | null
          avg_ret_21d?: number | null
          avg_ret_5d?: number | null
          avg_rsi?: number | null
          blended_strength?: number | null
          computed_at?: string
          id?: string
          participation_delta?: number | null
          pct_above_ema50?: number | null
          sector?: string
          stock_count?: number | null
          strength_rank?: number | null
          trade_date?: string
        }
        Relationships: []
      }
      market_shares_outstanding: {
        Row: {
          as_of: string
          created_at: string
          fetched_at: string
          free_float_shares: number | null
          source: string
          source_hash: string | null
          symbol: string
          total_shares: number | null
          updated_at: string
        }
        Insert: {
          as_of: string
          created_at?: string
          fetched_at?: string
          free_float_shares?: number | null
          source: string
          source_hash?: string | null
          symbol: string
          total_shares?: number | null
          updated_at?: string
        }
        Update: {
          as_of?: string
          created_at?: string
          fetched_at?: string
          free_float_shares?: number | null
          source?: string
          source_hash?: string | null
          symbol?: string
          total_shares?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      market_stock_ai: {
        Row: {
          computed_at: string
          confidence: number | null
          created_at: string
          entry_price: number | null
          exchange: string
          holding_period_days: number | null
          id: string
          payload: Json
          rationale: string | null
          recommendation: string | null
          risk_level: string | null
          score_hash: string | null
          stop_loss: number | null
          symbol: string
          targets: number[] | null
          user_id: string
        }
        Insert: {
          computed_at?: string
          confidence?: number | null
          created_at?: string
          entry_price?: number | null
          exchange?: string
          holding_period_days?: number | null
          id?: string
          payload: Json
          rationale?: string | null
          recommendation?: string | null
          risk_level?: string | null
          score_hash?: string | null
          stop_loss?: number | null
          symbol: string
          targets?: number[] | null
          user_id?: string
        }
        Update: {
          computed_at?: string
          confidence?: number | null
          created_at?: string
          entry_price?: number | null
          exchange?: string
          holding_period_days?: number | null
          id?: string
          payload?: Json
          rationale?: string | null
          recommendation?: string | null
          risk_level?: string | null
          score_hash?: string | null
          stop_loss?: number | null
          symbol?: string
          targets?: number[] | null
          user_id?: string
        }
        Relationships: []
      }
      market_stock_scores: {
        Row: {
          above_ema200: boolean | null
          adx14: number | null
          atr_contracting: boolean | null
          atr_pct: number | null
          atr14: number | null
          bars_available: number | null
          base_depth_pct: number | null
          base_duration_days: number | null
          base_len_days: number | null
          base_tightness: number | null
          bb_lower: number | null
          bb_percent_b: number | null
          bb_squeeze: boolean | null
          bb_upper: number | null
          bb_width: number | null
          breakout_band: string | null
          breakout_freshness_days: number | null
          breakout_level_cleared: number | null
          breakout_rank_pct: number | null
          breakout_score: number | null
          breakout_score_v2: number | null
          breakout_score_v4: number | null
          breakout_state: string | null
          breakout_state_days: number | null
          breakout_v4_components: Json | null
          breakout_v4_coverage: Json | null
          breakout_v4_rank_pct: number | null
          change_pct: number | null
          change_pct_adjusted: number | null
          close: number | null
          close_adjusted: number | null
          close_in_range_pct: number | null
          computed_at: string
          context_complete: boolean
          delivery_pct: number | null
          depth_imbalance: number | null
          dist_from_pivot_atr: number | null
          dist_to_resistance_atr: number | null
          ema_cross_20_50_days: number | null
          ema_cross_50_200_days: number | null
          ema100: number | null
          ema20: number | null
          ema200: number | null
          ema50: number | null
          exchange: string
          high_52w: number | null
          higher_lows: boolean | null
          id: string
          intraday_components: Json | null
          intraday_score: number | null
          is_liquid_tradable: boolean | null
          is_stale: boolean
          iv_rank: number | null
          liquidity_reasons: Json | null
          low_52w: number | null
          macd: number | null
          macd_hist: number | null
          macd_hist_rising: boolean | null
          macd_signal: number | null
          mfi14: number | null
          near_resistance: boolean | null
          obv: number | null
          obv_slope_20: number | null
          pattern_flags: Json | null
          pcr: number | null
          pct_from_52w_high: number | null
          pe_ttm: number | null
          pivot_level: number | null
          pivot_touch_quality: number | null
          pivot_touches: number | null
          prebreakout_score: number | null
          prev_close_adjusted: number | null
          price_source: string | null
          rel_strength_nifty: number | null
          rel_volume: number | null
          rel_volume_median30: number | null
          resistance_above: number | null
          resistance_fallback: boolean | null
          resistance_level: number | null
          ret_21d: number | null
          ret_55d: number | null
          ret_5d: number | null
          ret_ytd: number | null
          revenue_growth: number | null
          roe: number | null
          rolling_high_20: number | null
          rolling_high_20_date: string | null
          rolling_high_20_touch_quality: number | null
          rolling_high_20_touches: number | null
          rolling_high_55: number | null
          rolling_high_55_date: string | null
          rs_percentile: number | null
          rs_percentile_nifty: number | null
          rsi14: number | null
          score_components: Json | null
          score_components_v2: Json | null
          score_coverage: Json | null
          score_unavailable_reason: string | null
          sector: string | null
          sector_strength: number | null
          supertrend: number | null
          supertrend_dir: number | null
          support_fallback: boolean | null
          support_level: number | null
          swing_components: Json | null
          swing_rank_pct: number | null
          swing_score: number | null
          symbol: string
          trade_date: string | null
          vol_avg20: number | null
          vol_avg30: number | null
          vol_dryup_ratio: number | null
          vol_dryup_ratio_base: number | null
          volume: number | null
          volume_bse: number | null
          volume_nse: number | null
          vwap: number | null
          weekly_bars: number | null
          weekly_close: number | null
          weekly_ema20: number | null
          weekly_higher_lows: boolean | null
          weekly_rsi14: number | null
          weekly_trend_up: boolean | null
        }
        Insert: {
          above_ema200?: boolean | null
          adx14?: number | null
          atr_contracting?: boolean | null
          atr_pct?: number | null
          atr14?: number | null
          bars_available?: number | null
          base_depth_pct?: number | null
          base_duration_days?: number | null
          base_len_days?: number | null
          base_tightness?: number | null
          bb_lower?: number | null
          bb_percent_b?: number | null
          bb_squeeze?: boolean | null
          bb_upper?: number | null
          bb_width?: number | null
          breakout_band?: string | null
          breakout_freshness_days?: number | null
          breakout_level_cleared?: number | null
          breakout_rank_pct?: number | null
          breakout_score?: number | null
          breakout_score_v2?: number | null
          breakout_score_v4?: number | null
          breakout_state?: string | null
          breakout_state_days?: number | null
          breakout_v4_components?: Json | null
          breakout_v4_coverage?: Json | null
          breakout_v4_rank_pct?: number | null
          change_pct?: number | null
          change_pct_adjusted?: number | null
          close?: number | null
          close_adjusted?: number | null
          close_in_range_pct?: number | null
          computed_at?: string
          context_complete?: boolean
          delivery_pct?: number | null
          depth_imbalance?: number | null
          dist_from_pivot_atr?: number | null
          dist_to_resistance_atr?: number | null
          ema_cross_20_50_days?: number | null
          ema_cross_50_200_days?: number | null
          ema100?: number | null
          ema20?: number | null
          ema200?: number | null
          ema50?: number | null
          exchange?: string
          high_52w?: number | null
          higher_lows?: boolean | null
          id?: string
          intraday_components?: Json | null
          intraday_score?: number | null
          is_liquid_tradable?: boolean | null
          is_stale?: boolean
          iv_rank?: number | null
          liquidity_reasons?: Json | null
          low_52w?: number | null
          macd?: number | null
          macd_hist?: number | null
          macd_hist_rising?: boolean | null
          macd_signal?: number | null
          mfi14?: number | null
          near_resistance?: boolean | null
          obv?: number | null
          obv_slope_20?: number | null
          pattern_flags?: Json | null
          pcr?: number | null
          pct_from_52w_high?: number | null
          pe_ttm?: number | null
          pivot_level?: number | null
          pivot_touch_quality?: number | null
          pivot_touches?: number | null
          prebreakout_score?: number | null
          prev_close_adjusted?: number | null
          price_source?: string | null
          rel_strength_nifty?: number | null
          rel_volume?: number | null
          rel_volume_median30?: number | null
          resistance_above?: number | null
          resistance_fallback?: boolean | null
          resistance_level?: number | null
          ret_21d?: number | null
          ret_55d?: number | null
          ret_5d?: number | null
          ret_ytd?: number | null
          revenue_growth?: number | null
          roe?: number | null
          rolling_high_20?: number | null
          rolling_high_20_date?: string | null
          rolling_high_20_touch_quality?: number | null
          rolling_high_20_touches?: number | null
          rolling_high_55?: number | null
          rolling_high_55_date?: string | null
          rs_percentile?: number | null
          rs_percentile_nifty?: number | null
          rsi14?: number | null
          score_components?: Json | null
          score_components_v2?: Json | null
          score_coverage?: Json | null
          score_unavailable_reason?: string | null
          sector?: string | null
          sector_strength?: number | null
          supertrend?: number | null
          supertrend_dir?: number | null
          support_fallback?: boolean | null
          support_level?: number | null
          swing_components?: Json | null
          swing_rank_pct?: number | null
          swing_score?: number | null
          symbol: string
          trade_date?: string | null
          vol_avg20?: number | null
          vol_avg30?: number | null
          vol_dryup_ratio?: number | null
          vol_dryup_ratio_base?: number | null
          volume?: number | null
          volume_bse?: number | null
          volume_nse?: number | null
          vwap?: number | null
          weekly_bars?: number | null
          weekly_close?: number | null
          weekly_ema20?: number | null
          weekly_higher_lows?: boolean | null
          weekly_rsi14?: number | null
          weekly_trend_up?: boolean | null
        }
        Update: {
          above_ema200?: boolean | null
          adx14?: number | null
          atr_contracting?: boolean | null
          atr_pct?: number | null
          atr14?: number | null
          bars_available?: number | null
          base_depth_pct?: number | null
          base_duration_days?: number | null
          base_len_days?: number | null
          base_tightness?: number | null
          bb_lower?: number | null
          bb_percent_b?: number | null
          bb_squeeze?: boolean | null
          bb_upper?: number | null
          bb_width?: number | null
          breakout_band?: string | null
          breakout_freshness_days?: number | null
          breakout_level_cleared?: number | null
          breakout_rank_pct?: number | null
          breakout_score?: number | null
          breakout_score_v2?: number | null
          breakout_score_v4?: number | null
          breakout_state?: string | null
          breakout_state_days?: number | null
          breakout_v4_components?: Json | null
          breakout_v4_coverage?: Json | null
          breakout_v4_rank_pct?: number | null
          change_pct?: number | null
          change_pct_adjusted?: number | null
          close?: number | null
          close_adjusted?: number | null
          close_in_range_pct?: number | null
          computed_at?: string
          context_complete?: boolean
          delivery_pct?: number | null
          depth_imbalance?: number | null
          dist_from_pivot_atr?: number | null
          dist_to_resistance_atr?: number | null
          ema_cross_20_50_days?: number | null
          ema_cross_50_200_days?: number | null
          ema100?: number | null
          ema20?: number | null
          ema200?: number | null
          ema50?: number | null
          exchange?: string
          high_52w?: number | null
          higher_lows?: boolean | null
          id?: string
          intraday_components?: Json | null
          intraday_score?: number | null
          is_liquid_tradable?: boolean | null
          is_stale?: boolean
          iv_rank?: number | null
          liquidity_reasons?: Json | null
          low_52w?: number | null
          macd?: number | null
          macd_hist?: number | null
          macd_hist_rising?: boolean | null
          macd_signal?: number | null
          mfi14?: number | null
          near_resistance?: boolean | null
          obv?: number | null
          obv_slope_20?: number | null
          pattern_flags?: Json | null
          pcr?: number | null
          pct_from_52w_high?: number | null
          pe_ttm?: number | null
          pivot_level?: number | null
          pivot_touch_quality?: number | null
          pivot_touches?: number | null
          prebreakout_score?: number | null
          prev_close_adjusted?: number | null
          price_source?: string | null
          rel_strength_nifty?: number | null
          rel_volume?: number | null
          rel_volume_median30?: number | null
          resistance_above?: number | null
          resistance_fallback?: boolean | null
          resistance_level?: number | null
          ret_21d?: number | null
          ret_55d?: number | null
          ret_5d?: number | null
          ret_ytd?: number | null
          revenue_growth?: number | null
          roe?: number | null
          rolling_high_20?: number | null
          rolling_high_20_date?: string | null
          rolling_high_20_touch_quality?: number | null
          rolling_high_20_touches?: number | null
          rolling_high_55?: number | null
          rolling_high_55_date?: string | null
          rs_percentile?: number | null
          rs_percentile_nifty?: number | null
          rsi14?: number | null
          score_components?: Json | null
          score_components_v2?: Json | null
          score_coverage?: Json | null
          score_unavailable_reason?: string | null
          sector?: string | null
          sector_strength?: number | null
          supertrend?: number | null
          supertrend_dir?: number | null
          support_fallback?: boolean | null
          support_level?: number | null
          swing_components?: Json | null
          swing_rank_pct?: number | null
          swing_score?: number | null
          symbol?: string
          trade_date?: string | null
          vol_avg20?: number | null
          vol_avg30?: number | null
          vol_dryup_ratio?: number | null
          vol_dryup_ratio_base?: number | null
          volume?: number | null
          volume_bse?: number | null
          volume_nse?: number | null
          vwap?: number | null
          weekly_bars?: number | null
          weekly_close?: number | null
          weekly_ema20?: number | null
          weekly_higher_lows?: boolean | null
          weekly_rsi14?: number | null
          weekly_trend_up?: boolean | null
        }
        Relationships: []
      }
      market_stocks: {
        Row: {
          company_name: string | null
          created_at: string
          exchange: string
          face_value: number | null
          fno_enabled: boolean
          free_float_cr: number | null
          history_backfill_attempted_at: string | null
          history_backfill_attempts: number
          history_backfill_error: string | null
          id: string
          in_universe: boolean
          industry: string | null
          instrument_type: string | null
          is_active: boolean
          is_nifty500: boolean
          isin: string | null
          kotak_segment: string | null
          last_fundamentals_sync_at: string | null
          last_price_sync_at: string | null
          lot_size: number | null
          market_cap: number | null
          market_cap_as_of: string | null
          market_cap_calc_at: string | null
          market_cap_source: string | null
          next_earnings_at: string | null
          pe_ttm: number | null
          penny_checked_at: string | null
          penny_excluded: boolean
          penny_reason: string | null
          price_data_missing_at: string | null
          price_sync_attempts: number
          price_sync_attempts_day: string | null
          roe: number | null
          sector: string | null
          series: string | null
          shares_as_of: string | null
          shares_source: string | null
          shares_sync_attempted_at: string | null
          shares_sync_attempts: number
          sub_sector: string | null
          sub_sector_source: string | null
          symbol: string
          tick_size: number | null
          tickertape_sid: string | null
          tickertape_sid_as_of: string | null
          token: string | null
          token_missing_at: string | null
          total_shares_cr: number | null
          updated_at: string
          yahoo_symbol: string | null
        }
        Insert: {
          company_name?: string | null
          created_at?: string
          exchange: string
          face_value?: number | null
          fno_enabled?: boolean
          free_float_cr?: number | null
          history_backfill_attempted_at?: string | null
          history_backfill_attempts?: number
          history_backfill_error?: string | null
          id?: string
          in_universe?: boolean
          industry?: string | null
          instrument_type?: string | null
          is_active?: boolean
          is_nifty500?: boolean
          isin?: string | null
          kotak_segment?: string | null
          last_fundamentals_sync_at?: string | null
          last_price_sync_at?: string | null
          lot_size?: number | null
          market_cap?: number | null
          market_cap_as_of?: string | null
          market_cap_calc_at?: string | null
          market_cap_source?: string | null
          next_earnings_at?: string | null
          pe_ttm?: number | null
          penny_checked_at?: string | null
          penny_excluded?: boolean
          penny_reason?: string | null
          price_data_missing_at?: string | null
          price_sync_attempts?: number
          price_sync_attempts_day?: string | null
          roe?: number | null
          sector?: string | null
          series?: string | null
          shares_as_of?: string | null
          shares_source?: string | null
          shares_sync_attempted_at?: string | null
          shares_sync_attempts?: number
          sub_sector?: string | null
          sub_sector_source?: string | null
          symbol: string
          tick_size?: number | null
          tickertape_sid?: string | null
          tickertape_sid_as_of?: string | null
          token?: string | null
          token_missing_at?: string | null
          total_shares_cr?: number | null
          updated_at?: string
          yahoo_symbol?: string | null
        }
        Update: {
          company_name?: string | null
          created_at?: string
          exchange?: string
          face_value?: number | null
          fno_enabled?: boolean
          free_float_cr?: number | null
          history_backfill_attempted_at?: string | null
          history_backfill_attempts?: number
          history_backfill_error?: string | null
          id?: string
          in_universe?: boolean
          industry?: string | null
          instrument_type?: string | null
          is_active?: boolean
          is_nifty500?: boolean
          isin?: string | null
          kotak_segment?: string | null
          last_fundamentals_sync_at?: string | null
          last_price_sync_at?: string | null
          lot_size?: number | null
          market_cap?: number | null
          market_cap_as_of?: string | null
          market_cap_calc_at?: string | null
          market_cap_source?: string | null
          next_earnings_at?: string | null
          pe_ttm?: number | null
          penny_checked_at?: string | null
          penny_excluded?: boolean
          penny_reason?: string | null
          price_data_missing_at?: string | null
          price_sync_attempts?: number
          price_sync_attempts_day?: string | null
          roe?: number | null
          sector?: string | null
          series?: string | null
          shares_as_of?: string | null
          shares_source?: string | null
          shares_sync_attempted_at?: string | null
          shares_sync_attempts?: number
          sub_sector?: string | null
          sub_sector_source?: string | null
          symbol?: string
          tick_size?: number | null
          tickertape_sid?: string | null
          tickertape_sid_as_of?: string | null
          token?: string | null
          token_missing_at?: string | null
          total_shares_cr?: number | null
          updated_at?: string
          yahoo_symbol?: string | null
        }
        Relationships: []
      }
      market_surface_probes: {
        Row: {
          checked_at: string
          created_at: string
          detail: string | null
          id: string
          is_primary_path: boolean
          latency_ms: number | null
          ok: boolean
          plane: string
          provider: string
          state: string
          supported: boolean
          surface: string
          updated_at: string
        }
        Insert: {
          checked_at?: string
          created_at?: string
          detail?: string | null
          id?: string
          is_primary_path?: boolean
          latency_ms?: number | null
          ok?: boolean
          plane?: string
          provider: string
          state?: string
          supported?: boolean
          surface: string
          updated_at?: string
        }
        Update: {
          checked_at?: string
          created_at?: string
          detail?: string | null
          id?: string
          is_primary_path?: boolean
          latency_ms?: number | null
          ok?: boolean
          plane?: string
          provider?: string
          state?: string
          supported?: boolean
          surface?: string
          updated_at?: string
        }
        Relationships: []
      }
      market_sweep_snapshot: {
        Row: {
          chunk_count: number
          chunk_size: number
          created_at: string
          expires_at: string
          payload: Json
          session_date: string
          snapshot_version: number
          sweep_id: string
          symbol_count: number
          watch_hash: string | null
        }
        Insert: {
          chunk_count?: number
          chunk_size?: number
          created_at?: string
          expires_at?: string
          payload?: Json
          session_date: string
          snapshot_version?: number
          sweep_id: string
          symbol_count?: number
          watch_hash?: string | null
        }
        Update: {
          chunk_count?: number
          chunk_size?: number
          created_at?: string
          expires_at?: string
          payload?: Json
          session_date?: string
          snapshot_version?: number
          sweep_id?: string
          symbol_count?: number
          watch_hash?: string | null
        }
        Relationships: []
      }
      market_ticker_trace: {
        Row: {
          created_at: string
          duration_ms: number | null
          id: string
          input_hash: string | null
          notes: string | null
          output_hash: string | null
          params: Json | null
          source: string | null
          stage: string
          symbol: string
          trade_date: string
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          id?: string
          input_hash?: string | null
          notes?: string | null
          output_hash?: string | null
          params?: Json | null
          source?: string | null
          stage: string
          symbol: string
          trade_date: string
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          id?: string
          input_hash?: string | null
          notes?: string | null
          output_hash?: string | null
          params?: Json | null
          source?: string | null
          stage?: string
          symbol?: string
          trade_date?: string
        }
        Relationships: []
      }
      market_user_prefs: {
        Row: {
          allow_delayed_intraday: boolean
          brokerage_pct: number | null
          created_at: string
          default_risk_pct: number | null
          default_timeframe: string | null
          id: string
          notification_prefs: Json | null
          notify_browser: boolean | null
          notify_email: boolean | null
          notify_telegram: boolean | null
          portfolio_size: number | null
          refresh_seconds: number | null
          slippage_pct: number | null
          theme: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          allow_delayed_intraday?: boolean
          brokerage_pct?: number | null
          created_at?: string
          default_risk_pct?: number | null
          default_timeframe?: string | null
          id?: string
          notification_prefs?: Json | null
          notify_browser?: boolean | null
          notify_email?: boolean | null
          notify_telegram?: boolean | null
          portfolio_size?: number | null
          refresh_seconds?: number | null
          slippage_pct?: number | null
          theme?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          allow_delayed_intraday?: boolean
          brokerage_pct?: number | null
          created_at?: string
          default_risk_pct?: number | null
          default_timeframe?: string | null
          id?: string
          notification_prefs?: Json | null
          notify_browser?: boolean | null
          notify_email?: boolean | null
          notify_telegram?: boolean | null
          portfolio_size?: number | null
          refresh_seconds?: number | null
          slippage_pct?: number | null
          theme?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      market_value_audit: {
        Row: {
          checked_at: string
          delta_pct: number | null
          exchange: string
          field: string
          id: number
          metadata: Json
          our_value: number | null
          ref_source: string
          ref_value: number | null
          remediation: string | null
          run_id: string | null
          source_method: string | null
          source_provider: string | null
          status: string | null
          symbol: string
          threshold_pct: number | null
        }
        Insert: {
          checked_at?: string
          delta_pct?: number | null
          exchange?: string
          field: string
          id?: number
          metadata?: Json
          our_value?: number | null
          ref_source: string
          ref_value?: number | null
          remediation?: string | null
          run_id?: string | null
          source_method?: string | null
          source_provider?: string | null
          status?: string | null
          symbol: string
          threshold_pct?: number | null
        }
        Update: {
          checked_at?: string
          delta_pct?: number | null
          exchange?: string
          field?: string
          id?: number
          metadata?: Json
          our_value?: number | null
          ref_source?: string
          ref_value?: number | null
          remediation?: string | null
          run_id?: string | null
          source_method?: string | null
          source_provider?: string | null
          status?: string | null
          symbol?: string
          threshold_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "market_value_audit_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "market_reference_audit_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      market_watchlist_items: {
        Row: {
          color: string | null
          created_at: string
          exchange: string
          id: string
          notes: string | null
          priority: number | null
          symbol: string
          tags: string[] | null
          updated_at: string
          user_id: string
          watchlist_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          exchange?: string
          id?: string
          notes?: string | null
          priority?: number | null
          symbol: string
          tags?: string[] | null
          updated_at?: string
          user_id?: string
          watchlist_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          exchange?: string
          id?: string
          notes?: string | null
          priority?: number | null
          symbol?: string
          tags?: string[] | null
          updated_at?: string
          user_id?: string
          watchlist_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "market_watchlist_items_watchlist_id_fkey"
            columns: ["watchlist_id"]
            isOneToOne: false
            referencedRelation: "market_watchlists"
            referencedColumns: ["id"]
          },
        ]
      }
      market_watchlists: {
        Row: {
          color: string | null
          created_at: string
          id: string
          name: string
          sort_order: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          name: string
          sort_order?: number | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          name?: string
          sort_order?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      system_egress_daily: {
        Row: {
          bytes: number
          day: string
          id: string
          requests: number
          route: string
          source: string
          updated_at: string
        }
        Insert: {
          bytes?: number
          day?: string
          id?: string
          requests?: number
          route?: string
          source: string
          updated_at?: string
        }
        Update: {
          bytes?: number
          day?: string
          id?: string
          requests?: number
          route?: string
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      system_maintenance_log: {
        Row: {
          details: Json | null
          duration_ms: number | null
          id: string
          mode: string
          ran_at: string
          rows_deleted: Json
          size_bytes: number | null
          total_deleted: number
        }
        Insert: {
          details?: Json | null
          duration_ms?: number | null
          id?: string
          mode?: string
          ran_at?: string
          rows_deleted?: Json
          size_bytes?: number | null
          total_deleted?: number
        }
        Update: {
          details?: Json | null
          duration_ms?: number | null
          id?: string
          mode?: string
          ran_at?: string
          rows_deleted?: Json
          size_bytes?: number | null
          total_deleted?: number
        }
        Relationships: []
      }
      system_quota_state: {
        Row: {
          checked_at: string
          db_bytes: number
          db_reported_bytes: number | null
          egress_breakdown: Json
          egress_budget_bytes: number
          egress_bytes: number
          egress_cycle_day: number
          egress_limit_bytes: number
          egress_reported_at: string | null
          egress_reported_bytes: number | null
          egress_synced_at: string | null
          egress_window_end: string | null
          egress_window_start: string | null
          id: boolean
          last_level: string
          low_bandwidth: boolean
          storage_bytes: number
          updated_at: string
        }
        Insert: {
          checked_at?: string
          db_bytes?: number
          db_reported_bytes?: number | null
          egress_breakdown?: Json
          egress_budget_bytes?: number
          egress_bytes?: number
          egress_cycle_day?: number
          egress_limit_bytes?: number
          egress_reported_at?: string | null
          egress_reported_bytes?: number | null
          egress_synced_at?: string | null
          egress_window_end?: string | null
          egress_window_start?: string | null
          id?: boolean
          last_level?: string
          low_bandwidth?: boolean
          storage_bytes?: number
          updated_at?: string
        }
        Update: {
          checked_at?: string
          db_bytes?: number
          db_reported_bytes?: number | null
          egress_breakdown?: Json
          egress_budget_bytes?: number
          egress_bytes?: number
          egress_cycle_day?: number
          egress_limit_bytes?: number
          egress_reported_at?: string | null
          egress_reported_bytes?: number | null
          egress_synced_at?: string | null
          egress_window_end?: string | null
          egress_window_start?: string | null
          id?: boolean
          last_level?: string
          low_bandwidth?: boolean
          storage_bytes?: number
          updated_at?: string
        }
        Relationships: []
      }
      system_retention_config: {
        Row: {
          days: number
          key: string
          note: string | null
          updated_at: string
        }
        Insert: {
          days: number
          key: string
          note?: string | null
          updated_at?: string
        }
        Update: {
          days?: number
          key?: string
          note?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      user_page_access: {
        Row: {
          created_at: string
          id: string
          section: Database["public"]["Enums"]["app_section"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          section: Database["public"]["Enums"]["app_section"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          section?: Database["public"]["Enums"]["app_section"]
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      market_breadth_latest: {
        Row: {
          advances: number | null
          avg_rsi: number | null
          computed_at: string | null
          declines: number | null
          dii_net_cr: number | null
          fii_net_cr: number | null
          india_vix: number | null
          market_score: number | null
          new_highs: number | null
          new_lows: number | null
          nifty_change_pct: number | null
          nifty_close: number | null
          pct_above_ema20: number | null
          pct_above_ema200: number | null
          pct_above_ema50: number | null
          regime: string | null
          trade_date: string | null
          unchanged: number | null
        }
        Relationships: []
      }
      market_data_freshness: {
        Row: {
          lag_days: number | null
          latest_trade_date: string | null
          source: string | null
        }
        Relationships: []
      }
      market_fundamentals_sync_queue: {
        Row: {
          company_name: string | null
          exchange: string | null
          last_attempted_at: string | null
          last_fundamentals_sync_at: string | null
          queue_priority: number | null
          symbol: string | null
          sync_status: string | null
          yahoo_symbol: string | null
        }
        Relationships: []
      }
      market_live_price_status: {
        Row: {
          as_of: string | null
          completed_at: string | null
          coverage: number | null
          expected_count: number | null
          failed_count: number | null
          kotak_count: number | null
          priced_count: number | null
          session_date: string | null
          sweep_id: string | null
          yahoo_count: number | null
        }
        Relationships: []
      }
      market_pipeline_health: {
        Row: {
          failures_14d: number | null
          last_error: string | null
          last_failure_at: string | null
          last_success_at: string | null
          runs_14d: number | null
          stage: string | null
        }
        Relationships: []
      }
      market_pipeline_status: {
        Row: {
          active_stocks: number | null
          equities_covered: number | null
          equities_total: number | null
          equities_with_sector: number | null
          fundamentals_covered: number | null
          fundamentals_failed: number | null
          fundamentals_last_updated_at: string | null
          mcap_any_covered: number | null
          mcap_nse_covered: number | null
          scores_last_count: number | null
          scores_last_trade_date: string | null
          token_coverage_pct: number | null
          token_covered: number | null
        }
        Relationships: []
      }
      market_pipeline_token_coverage: {
        Row: {
          coverage_pct: number | null
          exchange: string | null
          total_active: number | null
          with_token: number | null
        }
        Relationships: []
      }
      market_reference_coverage: {
        Row: {
          active_symbols: number | null
          shares_coverage_pct: number | null
          shares_from_fmp: number | null
          shares_from_nse: number | null
          shares_from_yahoo: number | null
          shares_hard_failed: number | null
          shares_pending: number | null
          with_market_cap: number | null
          with_shares: number | null
        }
        Relationships: []
      }
      market_score_band_stats: {
        Row: {
          avg_rel_10d: number | null
          avg_rel_21d: number | null
          avg_rel_5d: number | null
          avg_ret_10d: number | null
          avg_ret_21d: number | null
          avg_ret_5d: number | null
          band: string | null
          first_date: string | null
          hit_rate_10d: number | null
          hit_rate_21d: number | null
          hit_rate_5d: number | null
          last_date: string | null
          liquid_n: number | null
          model: string | null
          neutral_n: number | null
          population: string | null
          rel_hit_rate_10d: number | null
          rel_hit_rate_21d: number | null
          rel_hit_rate_5d: number | null
          sample_10d: number | null
          sample_21d: number | null
          sample_5d: number | null
          sample_n: number | null
        }
        Relationships: []
      }
      market_screener_live: {
        Row: {
          above_ema200: boolean | null
          adx14: number | null
          atr_pct: number | null
          atr14: number | null
          bb_lower: number | null
          bb_squeeze: boolean | null
          bb_upper: number | null
          bb_width: number | null
          book_value: number | null
          breakout_score: number | null
          change_abs: number | null
          change_pct: number | null
          change_pct_raw: number | null
          close: number | null
          close_adjusted: number | null
          company_name: string | null
          computed_at: string | null
          current_ratio: number | null
          data_as_of: string | null
          data_provenance: Json | null
          debt_to_equity: number | null
          dii_holding: number | null
          dividend_yield: number | null
          ema100: number | null
          ema20: number | null
          ema200: number | null
          ema50: number | null
          eps_growth_yoy: number | null
          eps_ttm: number | null
          exchange: string | null
          face_value: number | null
          fii_holding: number | null
          fno_enabled: boolean | null
          fundamental_high_52w: number | null
          fundamental_low_52w: number | null
          fundamental_price: number | null
          fundamentals_updated_at: string | null
          high_52w: number | null
          higher_lows: boolean | null
          in_universe: boolean | null
          industry: string | null
          instrument_type: string | null
          intraday_score: number | null
          is_active: boolean | null
          is_liquid_tradable: boolean | null
          is_nifty500: boolean | null
          last_attempted_at: string | null
          last_error: string | null
          last_fundamentals_sync_at: string | null
          last_price_sync_at: string | null
          liquidity_reasons: Json | null
          low_52w: number | null
          macd: number | null
          macd_hist: number | null
          macd_signal: number | null
          market_cap: number | null
          market_cap_reported: number | null
          near_resistance: boolean | null
          pb: number | null
          pct_from_52w_high: number | null
          pe_ttm: number | null
          peg: number | null
          prebreakout_score: number | null
          previous_close: number | null
          profit_growth_yoy: number | null
          profit_ttm_cr: number | null
          promoter_holding: number | null
          promoter_pledge: number | null
          quick_ratio: number | null
          rel_strength_nifty: number | null
          rel_volume: number | null
          resistance_level: number | null
          ret_21d: number | null
          ret_5d: number | null
          ret_ytd: number | null
          revenue_growth_yoy: number | null
          revenue_ttm_cr: number | null
          roce: number | null
          roe: number | null
          rsi14: number | null
          score_components: Json | null
          score_id: string | null
          score_trade_date: string | null
          sector: string | null
          sector_strength: number | null
          sme: boolean | null
          strict_ok: boolean | null
          sub_sector: string | null
          support_level: number | null
          swing_score: number | null
          symbol: string | null
          sync_source: string | null
          sync_status: string | null
          trade_date: string | null
          vol_avg20: number | null
          vol_avg30: number | null
          vol_gt_avg30: boolean | null
          volume: number | null
          yahoo_symbol: string | null
        }
        Relationships: []
      }
      market_screener_rows: {
        Row: {
          above_ema200: boolean | null
          above_ema200_live: boolean | null
          adx14: number | null
          atr_pct: number | null
          atr_pct_live: number | null
          atr14: number | null
          bb_lower: number | null
          bb_squeeze: boolean | null
          bb_upper: number | null
          bb_width: number | null
          book_value: number | null
          breakout_score: number | null
          breakout_score_v4: number | null
          change_abs: number | null
          change_pct: number | null
          change_pct_raw: number | null
          close: number | null
          close_adjusted: number | null
          company_name: string | null
          computed_at: string | null
          current_ratio: number | null
          data_as_of: string | null
          data_provenance: Json | null
          debt_to_equity: number | null
          dii_holding: number | null
          dividend_yield: number | null
          dividend_yield_live: number | null
          earnings_yield_live: number | null
          ema100: number | null
          ema20: number | null
          ema200: number | null
          ema50: number | null
          eod_change_abs: number | null
          eod_change_pct: number | null
          eod_change_pct_raw: number | null
          eod_close: number | null
          eod_market_cap: number | null
          eod_previous_close: number | null
          eod_trade_date: string | null
          eod_vol_gt_avg30: boolean | null
          eod_volume: number | null
          eps_growth_yoy: number | null
          eps_ttm: number | null
          exchange: string | null
          face_value: number | null
          fii_holding: number | null
          fno_enabled: boolean | null
          fundamental_high_52w: number | null
          fundamental_low_52w: number | null
          fundamental_price: number | null
          fundamentals_updated_at: string | null
          high_52w: number | null
          high_52w_live: number | null
          higher_lows: boolean | null
          in_universe: boolean | null
          industry: string | null
          instrument_type: string | null
          intraday_score: number | null
          is_active: boolean | null
          is_liquid_tradable: boolean | null
          is_nifty500: boolean | null
          last_attempted_at: string | null
          last_error: string | null
          last_fundamentals_sync_at: string | null
          last_price_sync_at: string | null
          liquidity_reasons: Json | null
          live_age_s: number | null
          live_as_of: string | null
          live_provider: string | null
          live_session_date: string | null
          live_stale: boolean | null
          live_sweep_id: string | null
          live_volume: number | null
          low_52w: number | null
          low_52w_live: number | null
          macd: number | null
          macd_hist: number | null
          macd_signal: number | null
          market_cap: number | null
          market_cap_reported: number | null
          mcap_basis: string | null
          near_resistance: boolean | null
          near_resistance_live: boolean | null
          pb: number | null
          pb_live: number | null
          pct_from_52w_high: number | null
          pct_from_52w_high_live: number | null
          pe_live: number | null
          pe_ttm: number | null
          peg: number | null
          peg_live: number | null
          prebreakout_score: number | null
          previous_close: number | null
          price_basis_ratio: number | null
          profit_growth_yoy: number | null
          profit_ttm_cr: number | null
          promoter_holding: number | null
          promoter_pledge: number | null
          quick_ratio: number | null
          quote_state: string | null
          refreshed_at: string | null
          rel_strength_nifty: number | null
          rel_volume: number | null
          rel_volume_live: number | null
          resistance_level: number | null
          ret_21d: number | null
          ret_5d: number | null
          ret_ytd: number | null
          revenue_growth_yoy: number | null
          revenue_ttm_cr: number | null
          roce: number | null
          roe: number | null
          rsi14: number | null
          score_components: Json | null
          score_id: string | null
          score_trade_date: string | null
          sector: string | null
          sector_strength: number | null
          session_elapsed_frac: number | null
          sme: boolean | null
          stale_live_session_date: string | null
          strict_ok: boolean | null
          sub_sector: string | null
          support_level: number | null
          swing_score: number | null
          symbol: string | null
          sync_source: string | null
          sync_status: string | null
          trade_date: string | null
          vol_avg20: number | null
          vol_avg30: number | null
          vol_gt_avg30: boolean | null
          vol_gt_avg30_paced: boolean | null
          vol_pace_ratio: number | null
          volume: number | null
          yahoo_symbol: string | null
        }
        Relationships: []
      }
      market_top_movers: {
        Row: {
          breakout_score: number | null
          change_pct: number | null
          close: number | null
          direction: string | null
          exchange: string | null
          rel_volume: number | null
          rn: number | null
          rsi14: number | null
          sector: string | null
          symbol: string | null
          trade_date: string | null
          volume: number | null
        }
        Relationships: []
      }
      market_top_movers_daily: {
        Row: {
          breakout_score: number | null
          change_pct: number | null
          close: number | null
          direction: string | null
          exchange: string | null
          rel_volume: number | null
          rn: number | null
          rsi14: number | null
          sector: string | null
          symbol: string | null
          trade_date: string | null
          volume: number | null
        }
        Relationships: []
      }
      market_universe: {
        Row: {
          company_name: string | null
          created_at: string | null
          exchange: string | null
          face_value: number | null
          fno_enabled: boolean | null
          free_float_cr: number | null
          history_backfill_attempted_at: string | null
          history_backfill_attempts: number | null
          history_backfill_error: string | null
          id: string | null
          in_universe: boolean | null
          industry: string | null
          instrument_type: string | null
          is_active: boolean | null
          is_nifty500: boolean | null
          isin: string | null
          kotak_segment: string | null
          last_fundamentals_sync_at: string | null
          last_price_sync_at: string | null
          lot_size: number | null
          market_cap: number | null
          market_cap_as_of: string | null
          market_cap_calc_at: string | null
          market_cap_source: string | null
          next_earnings_at: string | null
          pe_ttm: number | null
          penny_checked_at: string | null
          penny_excluded: boolean | null
          penny_reason: string | null
          price_data_missing_at: string | null
          price_sync_attempts: number | null
          price_sync_attempts_day: string | null
          roe: number | null
          sector: string | null
          series: string | null
          shares_as_of: string | null
          shares_source: string | null
          shares_sync_attempted_at: string | null
          shares_sync_attempts: number | null
          sub_sector: string | null
          sub_sector_source: string | null
          symbol: string | null
          tick_size: number | null
          tickertape_sid: string | null
          tickertape_sid_as_of: string | null
          token: string | null
          token_missing_at: string | null
          total_shares_cr: number | null
          updated_at: string | null
          yahoo_symbol: string | null
        }
        Insert: {
          company_name?: string | null
          created_at?: string | null
          exchange?: string | null
          face_value?: number | null
          fno_enabled?: boolean | null
          free_float_cr?: number | null
          history_backfill_attempted_at?: string | null
          history_backfill_attempts?: number | null
          history_backfill_error?: string | null
          id?: string | null
          in_universe?: boolean | null
          industry?: string | null
          instrument_type?: string | null
          is_active?: boolean | null
          is_nifty500?: boolean | null
          isin?: string | null
          kotak_segment?: string | null
          last_fundamentals_sync_at?: string | null
          last_price_sync_at?: string | null
          lot_size?: number | null
          market_cap?: number | null
          market_cap_as_of?: string | null
          market_cap_calc_at?: string | null
          market_cap_source?: string | null
          next_earnings_at?: string | null
          pe_ttm?: number | null
          penny_checked_at?: string | null
          penny_excluded?: boolean | null
          penny_reason?: string | null
          price_data_missing_at?: string | null
          price_sync_attempts?: number | null
          price_sync_attempts_day?: string | null
          roe?: number | null
          sector?: string | null
          series?: string | null
          shares_as_of?: string | null
          shares_source?: string | null
          shares_sync_attempted_at?: string | null
          shares_sync_attempts?: number | null
          sub_sector?: string | null
          sub_sector_source?: string | null
          symbol?: string | null
          tick_size?: number | null
          tickertape_sid?: string | null
          tickertape_sid_as_of?: string | null
          token?: string | null
          token_missing_at?: string | null
          total_shares_cr?: number | null
          updated_at?: string | null
          yahoo_symbol?: string | null
        }
        Update: {
          company_name?: string | null
          created_at?: string | null
          exchange?: string | null
          face_value?: number | null
          fno_enabled?: boolean | null
          free_float_cr?: number | null
          history_backfill_attempted_at?: string | null
          history_backfill_attempts?: number | null
          history_backfill_error?: string | null
          id?: string | null
          in_universe?: boolean | null
          industry?: string | null
          instrument_type?: string | null
          is_active?: boolean | null
          is_nifty500?: boolean | null
          isin?: string | null
          kotak_segment?: string | null
          last_fundamentals_sync_at?: string | null
          last_price_sync_at?: string | null
          lot_size?: number | null
          market_cap?: number | null
          market_cap_as_of?: string | null
          market_cap_calc_at?: string | null
          market_cap_source?: string | null
          next_earnings_at?: string | null
          pe_ttm?: number | null
          penny_checked_at?: string | null
          penny_excluded?: boolean | null
          penny_reason?: string | null
          price_data_missing_at?: string | null
          price_sync_attempts?: number | null
          price_sync_attempts_day?: string | null
          roe?: number | null
          sector?: string | null
          series?: string | null
          shares_as_of?: string | null
          shares_source?: string | null
          shares_sync_attempted_at?: string | null
          shares_sync_attempts?: number | null
          sub_sector?: string | null
          sub_sector_source?: string | null
          symbol?: string | null
          tick_size?: number | null
          tickertape_sid?: string | null
          tickertape_sid_as_of?: string | null
          token?: string | null
          token_missing_at?: string | null
          total_shares_cr?: number | null
          updated_at?: string | null
          yahoo_symbol?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      apply_egress_governor: { Args: never; Returns: Json }
      archive_coverage: { Args: never; Returns: Json }
      begin_market_live_sweep: {
        Args: {
          _as_of: string
          _session_date: string
          _stale_after?: string
          _sweep_id: string
        }
        Returns: Json
      }
      claim_market_fundamentals_sync: {
        Args: { _limit?: number }
        Returns: {
          company_name: string
          exchange: string
          last_attempted_at: string
          last_fundamentals_sync_at: string
          queue_priority: number
          symbol: string
          yahoo_symbol: string
        }[]
      }
      db_size_report: { Args: never; Returns: Json }
      egress_cycle_rollup: { Args: never; Returns: Json }
      ema_step: {
        Args: { k: number; state: number; val: number }
        Returns: number
      }
      evaluate_score_history_forward: {
        Args: { _limit?: number }
        Returns: number
      }
      fit_score_calibration:
        | { Args: { _min_n?: number; _model?: string }; Returns: number }
        | {
            Args: {
              _min_n?: number
              _min_sessions?: number
              _min_symbols?: number
              _min_symbols_neutral?: number
              _model?: string
            }
            Returns: number
          }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_section_access: {
        Args: {
          _section: Database["public"]["Enums"]["app_section"]
          _user_id: string
        }
        Returns: boolean
      }
      market_archive_candidates: {
        Args: { _hot_other?: number; _hot_tracked?: number; _limit?: number }
        Returns: {
          cold_bars: number
          cutoff: string
          exchange: string
          symbol: string
        }[]
      }
      market_asof_candles: {
        Args: { _as_of: string; _bars?: number; _symbols: string[] }
        Returns: {
          candles: Json
          symbol: string
        }[]
      }
      market_cron_call: { Args: { fn_name: string }; Returns: number }
      market_cron_call_body: {
        Args: { fn_name: string; payload?: Json }
        Returns: number
      }
      market_cron_secret_for_service: { Args: never; Returns: string }
      market_feed_freshness: {
        Args: never
        Returns: {
          column_name: string
          last_at: string
          table_name: string
        }[]
      }
      market_history_backfill_candidates: {
        Args: { _limit?: number; _min_bars?: number }
        Returns: {
          bars: number
          exchange: string
          symbol: string
          yahoo_symbol: string
        }[]
      }
      market_is_non_equity: {
        Args: {
          _company_name: string
          _instrument_type: string
          _series: string
          _symbol: string
        }
        Returns: boolean
      }
      market_live_settled_anchors: {
        Args: { _before: string; _symbols: string[] }
        Returns: {
          exchange: string
          prev_close: number
          symbol: string
          trade_date: string
        }[]
      }
      market_live_settled_anchors_lean: {
        Args: { _before: string; _symbols: string[] }
        Returns: {
          prev_close: number
          symbol: string
        }[]
      }
      market_live_sweep_universe: {
        Args: never
        Returns: {
          kotak_segment: string
          series: string
          symbol: string
          token: string
          total_shares_cr: number
          yahoo_symbol: string
        }[]
      }
      market_live_watch_universe: {
        Args: never
        Returns: {
          kotak_segment: string
          series: string
          symbol: string
          token: string
          total_shares_cr: number
          yahoo_symbol: string
        }[]
      }
      market_patch_stock_scores: { Args: { _rows: Json }; Returns: number }
      market_penny_purge: { Args: { _symbols: string[] }; Returns: number }
      market_penny_sweep: {
        Args: { _min_cap_cr?: number; _min_price?: number }
        Returns: Json
      }
      market_provider_stats_24h: {
        Args: never
        Returns: {
          attempts: number
          last_at: string
          ok_count: number
          ok_rate: number
          p50: number
          provider: string
        }[]
      }
      market_provider_surface_stats_24h: {
        Args: never
        Returns: {
          attempts: number
          endpoint: string
          last_at: string
          ok_rate: number
          p50_ms: number
          provider: string
        }[]
      }
      market_purge_orphans: { Args: never; Returns: Json }
      market_purge_symbols: { Args: { _symbols: string[] }; Returns: number }
      market_rescore_latest_from_prices: {
        Args: { _limit?: number; _trade_date?: string }
        Returns: number
      }
      market_rescore_prices_batch: {
        Args: { _after_symbol?: string; _limit?: number; _trade_date?: string }
        Returns: {
          last_symbol: string
          processed: number
          session_date: string
        }[]
      }
      market_score_backfill_candidates:
        | {
            Args: { _limit?: number; _min_rows?: number }
            Returns: {
              bars: number
              exchange: string
              market_cap: number
              sector: string
              symbol: string
            }[]
          }
        | {
            Args: { _limit?: number; _min_bars?: number; _min_rows?: number }
            Returns: {
              bars: number
              exchange: string
              market_cap: number
              sector: string
              symbol: string
            }[]
          }
      market_score_cohort:
        | {
            Args: { _days?: number; _model?: string; _threshold?: number }
            Returns: {
              avg_rel_21d: number
              avg_ret_10d: number
              avg_ret_21d: number
              avg_ret_5d: number
              avg_score: number
              hit_rate_21d: number
              matured_21: number
              matured_5: number
              n_qualified: number
              trade_date: string
            }[]
          }
        | {
            Args: {
              _days?: number
              _model?: string
              _population?: string
              _threshold?: number
            }
            Returns: {
              avg_rel_21d: number
              avg_ret_10d: number
              avg_ret_21d: number
              avg_ret_5d: number
              avg_score: number
              hit_rate_21d: number
              matured_21: number
              matured_5: number
              n_qualified: number
              trade_date: string
            }[]
          }
      market_score_cohort_symbols:
        | {
            Args: {
              _days?: number
              _limit?: number
              _model?: string
              _threshold?: number
            }
            Returns: {
              appearances: number
              avg_score: number
              best_ret_21d: number
              exchange: string
              first_date: string
              first_rel_21d: number
              first_ret_21d: number
              first_ret_5d: number
              last_date: string
              max_score: number
              symbol: string
            }[]
          }
        | {
            Args: {
              _days?: number
              _limit?: number
              _model?: string
              _population?: string
              _threshold?: number
            }
            Returns: {
              appearances: number
              avg_score: number
              best_ret_21d: number
              exchange: string
              first_date: string
              first_rel_21d: number
              first_ret_21d: number
              first_ret_5d: number
              last_date: string
              max_score: number
              symbol: string
            }[]
          }
      market_screener_et_parity: {
        Args: {
          _after_symbol?: string
          _limit?: number
          _min_change_pct?: number
          _min_market_cap?: number
          _min_price?: number
          _volume_above_avg?: boolean
        }
        Returns: {
          breakout_score_v4: number
          change_pct: number
          change_pct_raw: number
          close: number
          company_name: string
          exchange: string
          is_liquid_tradable: boolean
          live_as_of: string
          market_cap: number
          previous_close: number
          quote_state: string
          symbol: string
          trade_date: string
          vol_avg30: number
          volume: number
        }[]
      }
      promote_market_eod_session: {
        Args: { _trade_date?: string }
        Returns: {
          eligible_rows: number
          promoted_rows: number
          remaining_gap: number
          session_date: string
          skipped_rows: number
          source_rows: number
        }[]
      }
      promote_market_live_sweep: {
        Args: { _min_coverage?: number; _sweep_id: string }
        Returns: Json
      }
      prune_batched: { Args: { _sql: string }; Returns: number }
      prune_beyond_history_ceiling: { Args: never; Returns: Json }
      prune_old_data: { Args: { _aggressive?: boolean }; Returns: Json }
      purge_old_ticker_trace: { Args: never; Returns: undefined }
      quota_report: { Args: never; Returns: Json }
      record_egress: { Args: { _rows: Json; _source: string }; Returns: number }
      refresh_market_screener_snapshot: { Args: never; Returns: number }
      refresh_market_top_movers: { Args: never; Returns: undefined }
      refresh_score_distribution: { Args: { _model?: string }; Returns: number }
      repair_intraday_volume: {
        Args: { p_days?: number }
        Returns: {
          rows_rewritten: number
          sessions_repaired: number
        }[]
      }
      run_daily_maintenance: { Args: never; Returns: Json }
      score_history_coverage: { Args: { _model?: string }; Returns: Json }
      seed_default_indices: { Args: { _uid: string }; Returns: undefined }
      set_quota_reported: {
        Args: { _db_bytes?: number; _egress_bytes?: number }
        Returns: Json
      }
      stamp_score_history_ranks: { Args: { _model?: string }; Returns: number }
      verify_market_cron_secret: { Args: { _secret: string }; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "user"
      app_section: "market" | "config"
      email_category:
        | "important"
        | "needs_reply"
        | "follow_up"
        | "finance"
        | "work"
        | "personal"
        | "other"
      email_purpose: "work" | "finance" | "personal" | "other"
      jarvis_action_status: "pending" | "success" | "error"
      market_alert_channel: "browser" | "email" | "telegram" | "whatsapp"
      market_connection_status:
        | "disconnected"
        | "pending_otp"
        | "connected"
        | "expired"
        | "error"
      market_holding_source:
        | "manual"
        | "kotak_sync"
        | "zerodha_sync"
        | "dhan_sync"
        | "shoonya_sync"
      market_position_side: "long" | "short"
      market_provider: "kotak_neo" | "yahoo" | "zerodha" | "dhan" | "shoonya"
      note_type:
        | "general"
        | "project"
        | "meeting"
        | "sop"
        | "decision"
        | "reference"
        | "personal"
        | "finance"
      parse_status: "pending" | "parsed" | "failed" | "skipped"
      project_priority: "low" | "normal" | "high" | "urgent"
      project_status: "active" | "on_hold" | "done" | "archived"
      reconciliation_status:
        | "unreconciled"
        | "partial"
        | "reconciled"
        | "review"
      skeleton_scope: "user" | "system"
      statement_payment_status:
        | "na"
        | "pending"
        | "paid"
        | "overdue"
        | "partial"
      statement_type: "account" | "card" | "loan"
      task_priority: "low" | "normal" | "high" | "urgent"
      task_status: "todo" | "doing" | "waiting" | "done" | "cancelled"
      txn_source: "manual" | "email" | "statement" | "import"
      txn_type: "debit" | "credit" | "transfer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
      app_section: ["market", "config"],
      email_category: [
        "important",
        "needs_reply",
        "follow_up",
        "finance",
        "work",
        "personal",
        "other",
      ],
      email_purpose: ["work", "finance", "personal", "other"],
      jarvis_action_status: ["pending", "success", "error"],
      market_alert_channel: ["browser", "email", "telegram", "whatsapp"],
      market_connection_status: [
        "disconnected",
        "pending_otp",
        "connected",
        "expired",
        "error",
      ],
      market_holding_source: [
        "manual",
        "kotak_sync",
        "zerodha_sync",
        "dhan_sync",
        "shoonya_sync",
      ],
      market_position_side: ["long", "short"],
      market_provider: ["kotak_neo", "yahoo", "zerodha", "dhan", "shoonya"],
      note_type: [
        "general",
        "project",
        "meeting",
        "sop",
        "decision",
        "reference",
        "personal",
        "finance",
      ],
      parse_status: ["pending", "parsed", "failed", "skipped"],
      project_priority: ["low", "normal", "high", "urgent"],
      project_status: ["active", "on_hold", "done", "archived"],
      reconciliation_status: [
        "unreconciled",
        "partial",
        "reconciled",
        "review",
      ],
      skeleton_scope: ["user", "system"],
      statement_payment_status: ["na", "pending", "paid", "overdue", "partial"],
      statement_type: ["account", "card", "loan"],
      task_priority: ["low", "normal", "high", "urgent"],
      task_status: ["todo", "doing", "waiting", "done", "cancelled"],
      txn_source: ["manual", "email", "statement", "import"],
      txn_type: ["debit", "credit", "transfer"],
    },
  },
} as const
