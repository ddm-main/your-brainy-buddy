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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      areas: {
        Row: {
          health_check: string | null
          id: string
          name: string
          reviewed_at: string | null
          standard: string | null
          user_id: string
        }
        Insert: {
          health_check?: string | null
          id?: string
          name: string
          reviewed_at?: string | null
          standard?: string | null
          user_id?: string
        }
        Update: {
          health_check?: string | null
          id?: string
          name?: string
          reviewed_at?: string | null
          standard?: string | null
          user_id?: string
        }
        Relationships: []
      }
      banks: {
        Row: {
          created_at: string
          id: string
          name: string
          notes: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          user_id?: string
        }
        Relationships: []
      }
      credit_cards: {
        Row: {
          autopay: boolean
          bank_id: string | null
          billing_day: number | null
          card_name: string
          created_at: string
          due_day: number | null
          id: string
          limit_amount: number | null
          masked_number: string | null
          notes: string | null
          statement_password_rule: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          autopay?: boolean
          bank_id?: string | null
          billing_day?: number | null
          card_name: string
          created_at?: string
          due_day?: number | null
          id?: string
          limit_amount?: number | null
          masked_number?: string | null
          notes?: string | null
          statement_password_rule?: Json | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          autopay?: boolean
          bank_id?: string | null
          billing_day?: number | null
          card_name?: string
          created_at?: string
          due_day?: number | null
          id?: string
          limit_amount?: number | null
          masked_number?: string | null
          notes?: string | null
          statement_password_rule?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_cards_bank_id_fkey"
            columns: ["bank_id"]
            isOneToOne: false
            referencedRelation: "banks"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_logs: {
        Row: {
          content: string
          id: string
          log_date: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          id?: string
          log_date: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          content?: string
          id?: string
          log_date?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      decisions: {
        Row: {
          context: string | null
          created_at: string
          decided_on: string
          decision_text: string
          id: string
          linked_project_id: string | null
          options_considered: string | null
          rationale: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          context?: string | null
          created_at?: string
          decided_on?: string
          decision_text: string
          id?: string
          linked_project_id?: string | null
          options_considered?: string | null
          rationale?: string | null
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          context?: string | null
          created_at?: string
          decided_on?: string
          decision_text?: string
          id?: string
          linked_project_id?: string | null
          options_considered?: string | null
          rationale?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      email_accounts: {
        Row: {
          access_token: string | null
          auto_categorize: boolean
          connected_at: string | null
          created_at: string
          email_address: string
          finance_only: boolean
          finance_sender_filter: string | null
          google_sub: string | null
          history_id: string | null
          id: string
          is_active: boolean
          last_error: string | null
          last_synced_at: string | null
          max_per_sync: number
          notify_on_new: boolean
          paused_at: string | null
          permission_level: string
          provider: string | null
          purpose: Database["public"]["Enums"]["email_purpose"]
          refresh_token: string | null
          scopes: string | null
          sync_frequency: string
          sync_period_days: number
          sync_status: string | null
          token_expires_at: string | null
          use_case: string
          user_id: string
        }
        Insert: {
          access_token?: string | null
          auto_categorize?: boolean
          connected_at?: string | null
          created_at?: string
          email_address: string
          finance_only?: boolean
          finance_sender_filter?: string | null
          google_sub?: string | null
          history_id?: string | null
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_synced_at?: string | null
          max_per_sync?: number
          notify_on_new?: boolean
          paused_at?: string | null
          permission_level?: string
          provider?: string | null
          purpose?: Database["public"]["Enums"]["email_purpose"]
          refresh_token?: string | null
          scopes?: string | null
          sync_frequency?: string
          sync_period_days?: number
          sync_status?: string | null
          token_expires_at?: string | null
          use_case?: string
          user_id?: string
        }
        Update: {
          access_token?: string | null
          auto_categorize?: boolean
          connected_at?: string | null
          created_at?: string
          email_address?: string
          finance_only?: boolean
          finance_sender_filter?: string | null
          google_sub?: string | null
          history_id?: string | null
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_synced_at?: string | null
          max_per_sync?: number
          notify_on_new?: boolean
          paused_at?: string | null
          permission_level?: string
          provider?: string | null
          purpose?: Database["public"]["Enums"]["email_purpose"]
          refresh_token?: string | null
          scopes?: string | null
          sync_frequency?: string
          sync_period_days?: number
          sync_status?: string | null
          token_expires_at?: string | null
          use_case?: string
          user_id?: string
        }
        Relationships: []
      }
      email_actions: {
        Row: {
          action: string
          actor: string | null
          created_at: string
          email_id: string
          id: string
          meta: Json | null
          user_id: string
        }
        Insert: {
          action: string
          actor?: string | null
          created_at?: string
          email_id: string
          id?: string
          meta?: Json | null
          user_id?: string
        }
        Update: {
          action?: string
          actor?: string | null
          created_at?: string
          email_id?: string
          id?: string
          meta?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_actions_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
        ]
      }
      email_attachments: {
        Row: {
          attachment_type: string | null
          created_at: string
          email_id: string
          extracted_text: string | null
          file_name: string | null
          id: string
          mime: string | null
          parse_status: Database["public"]["Enums"]["parse_status"]
          storage_path: string | null
          user_id: string
        }
        Insert: {
          attachment_type?: string | null
          created_at?: string
          email_id: string
          extracted_text?: string | null
          file_name?: string | null
          id?: string
          mime?: string | null
          parse_status?: Database["public"]["Enums"]["parse_status"]
          storage_path?: string | null
          user_id?: string
        }
        Update: {
          attachment_type?: string | null
          created_at?: string
          email_id?: string
          extracted_text?: string | null
          file_name?: string | null
          id?: string
          mime?: string | null
          parse_status?: Database["public"]["Enums"]["parse_status"]
          storage_path?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_attachments_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
        ]
      }
      emails: {
        Row: {
          account_id: string | null
          ai_summary: string | null
          body_html: string | null
          body_text: string | null
          category: Database["public"]["Enums"]["email_category"] | null
          cc_json: Json | null
          created_at: string
          external_email_id: string | null
          finance_related: boolean
          from_email: string | null
          from_name: string | null
          id: string
          importance: number | null
          linked_bank_id: string | null
          linked_card_id: string | null
          linked_project_id: string | null
          provider: string | null
          received_at: string | null
          requires_action: boolean
          snippet: string | null
          subject: string | null
          thread_id: string | null
          to_json: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id?: string | null
          ai_summary?: string | null
          body_html?: string | null
          body_text?: string | null
          category?: Database["public"]["Enums"]["email_category"] | null
          cc_json?: Json | null
          created_at?: string
          external_email_id?: string | null
          finance_related?: boolean
          from_email?: string | null
          from_name?: string | null
          id?: string
          importance?: number | null
          linked_bank_id?: string | null
          linked_card_id?: string | null
          linked_project_id?: string | null
          provider?: string | null
          received_at?: string | null
          requires_action?: boolean
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_json?: Json | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          account_id?: string | null
          ai_summary?: string | null
          body_html?: string | null
          body_text?: string | null
          category?: Database["public"]["Enums"]["email_category"] | null
          cc_json?: Json | null
          created_at?: string
          external_email_id?: string | null
          finance_related?: boolean
          from_email?: string | null
          from_name?: string | null
          id?: string
          importance?: number | null
          linked_bank_id?: string | null
          linked_card_id?: string | null
          linked_project_id?: string | null
          provider?: string | null
          received_at?: string | null
          requires_action?: boolean
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_json?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emails_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "email_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_email_rules: {
        Row: {
          attachment_name_pattern: string | null
          bank_id: string | null
          card_id: string | null
          created_at: string
          email_account_id: string | null
          id: string
          is_active: boolean
          loan_id: string | null
          sender_pattern: string | null
          statement_password_rule: Json | null
          subject_pattern: string | null
          user_id: string
        }
        Insert: {
          attachment_name_pattern?: string | null
          bank_id?: string | null
          card_id?: string | null
          created_at?: string
          email_account_id?: string | null
          id?: string
          is_active?: boolean
          loan_id?: string | null
          sender_pattern?: string | null
          statement_password_rule?: Json | null
          subject_pattern?: string | null
          user_id?: string
        }
        Update: {
          attachment_name_pattern?: string | null
          bank_id?: string | null
          card_id?: string | null
          created_at?: string
          email_account_id?: string | null
          id?: string
          is_active?: boolean
          loan_id?: string | null
          sender_pattern?: string | null
          statement_password_rule?: Json | null
          subject_pattern?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_email_rules_bank_id_fkey"
            columns: ["bank_id"]
            isOneToOne: false
            referencedRelation: "banks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_email_rules_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "credit_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_email_rules_email_account_id_fkey"
            columns: ["email_account_id"]
            isOneToOne: false
            referencedRelation: "email_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_email_rules_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_accounts: {
        Row: {
          account_type: string | null
          bank_id: string | null
          created_at: string
          id: string
          masked_number: string | null
          nickname: string
          notes: string | null
          source_email: string | null
          statement_cycle_day: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          account_type?: string | null
          bank_id?: string | null
          created_at?: string
          id?: string
          masked_number?: string | null
          nickname: string
          notes?: string | null
          source_email?: string | null
          statement_cycle_day?: number | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          account_type?: string | null
          bank_id?: string | null
          created_at?: string
          id?: string
          masked_number?: string | null
          nickname?: string
          notes?: string | null
          source_email?: string | null
          statement_cycle_day?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_accounts_bank_id_fkey"
            columns: ["bank_id"]
            isOneToOne: false
            referencedRelation: "banks"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_goals: {
        Row: {
          created_at: string
          current_amount: number
          goal_type: string | null
          id: string
          linked_account_id: string | null
          target_amount: number | null
          target_date: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_amount?: number
          goal_type?: string | null
          id?: string
          linked_account_id?: string | null
          target_amount?: number | null
          target_date?: string | null
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          current_amount?: number
          goal_type?: string | null
          id?: string
          linked_account_id?: string | null
          target_amount?: number | null
          target_date?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_goals_linked_account_id_fkey"
            columns: ["linked_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_items: {
        Row: {
          captured_on: string
          content: string
          created_at: string
          id: string
          processed: boolean
          routed_to: string | null
          user_id: string
        }
        Insert: {
          captured_on?: string
          content: string
          created_at?: string
          id?: string
          processed?: boolean
          routed_to?: string | null
          user_id?: string
        }
        Update: {
          captured_on?: string
          content?: string
          created_at?: string
          id?: string
          processed?: boolean
          routed_to?: string | null
          user_id?: string
        }
        Relationships: []
      }
      jarvis_actions: {
        Row: {
          action_type: string
          command_text: string | null
          created_at: string
          id: string
          input: Json | null
          output: Json | null
          status: Database["public"]["Enums"]["jarvis_action_status"]
          target_module: string | null
          user_id: string
        }
        Insert: {
          action_type: string
          command_text?: string | null
          created_at?: string
          id?: string
          input?: Json | null
          output?: Json | null
          status?: Database["public"]["Enums"]["jarvis_action_status"]
          target_module?: string | null
          user_id?: string
        }
        Update: {
          action_type?: string
          command_text?: string | null
          created_at?: string
          id?: string
          input?: Json | null
          output?: Json | null
          status?: Database["public"]["Enums"]["jarvis_action_status"]
          target_module?: string | null
          user_id?: string
        }
        Relationships: []
      }
      jarvis_interactions: {
        Row: {
          assistant_text: string
          created_at: string
          id: string
          latency_ms: number | null
          meta: Json
          mode: string
          model: string
          provider: string
          screenshot_url: string | null
          user_id: string
          user_text: string
        }
        Insert: {
          assistant_text?: string
          created_at?: string
          id?: string
          latency_ms?: number | null
          meta?: Json
          mode?: string
          model?: string
          provider?: string
          screenshot_url?: string | null
          user_id?: string
          user_text: string
        }
        Update: {
          assistant_text?: string
          created_at?: string
          id?: string
          latency_ms?: number | null
          meta?: Json
          mode?: string
          model?: string
          provider?: string
          screenshot_url?: string | null
          user_id?: string
          user_text?: string
        }
        Relationships: []
      }
      jarvis_memory: {
        Row: {
          content: string
          created_at: string
          id: string
          tags: string[]
          topic: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          tags?: string[]
          topic: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          tags?: string[]
          topic?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      jarvis_reminders: {
        Row: {
          created_at: string
          fire_at: string
          fired: boolean
          id: string
          linked_task_id: string | null
          text: string
          user_id: string
        }
        Insert: {
          created_at?: string
          fire_at: string
          fired?: boolean
          id?: string
          linked_task_id?: string | null
          text: string
          user_id?: string
        }
        Update: {
          created_at?: string
          fire_at?: string
          fired?: boolean
          id?: string
          linked_task_id?: string | null
          text?: string
          user_id?: string
        }
        Relationships: []
      }
      jarvis_usage_daily: {
        Row: {
          created_at: string
          day: string
          requests: number
          tokens: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          day?: string
          requests?: number
          tokens?: number
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          day?: string
          requests?: number
          tokens?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      loans: {
        Row: {
          created_at: string
          emi_amount: number | null
          id: string
          interest_rate: number | null
          lender_name: string
          linked_account_id: string | null
          loan_type: string | null
          next_due_date: string | null
          outstanding_amount: number | null
          principal_amount: number | null
          start_date: string | null
          tenure_months: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emi_amount?: number | null
          id?: string
          interest_rate?: number | null
          lender_name: string
          linked_account_id?: string | null
          loan_type?: string | null
          next_due_date?: string | null
          outstanding_amount?: number | null
          principal_amount?: number | null
          start_date?: string | null
          tenure_months?: number | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          emi_amount?: number | null
          id?: string
          interest_rate?: number | null
          lender_name?: string
          linked_account_id?: string | null
          loan_type?: string | null
          next_due_date?: string | null
          outstanding_amount?: number | null
          principal_amount?: number | null
          start_date?: string | null
          tenure_months?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "loans_linked_account_id_fkey"
            columns: ["linked_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      memories: {
        Row: {
          category: string
          content: string
          created_at: string
          id: string
          source_file: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          category: string
          content: string
          created_at?: string
          id?: string
          source_file?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          category?: string
          content?: string
          created_at?: string
          id?: string
          source_file?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          created_at: string
          id: string
          parts: Json
          role: string
          thread_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          parts: Json
          role: string
          thread_id: string
        }
        Update: {
          created_at?: string
          id?: string
          parts?: Json
          role?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["id"]
          },
        ]
      }
      next_actions: {
        Row: {
          completed_at: string | null
          created_at: string
          description: string
          done: boolean
          id: string
          project_id: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          description: string
          done?: boolean
          id?: string
          project_id: string
          user_id?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          description?: string
          done?: boolean
          id?: string
          project_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "next_actions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          content: string | null
          created_at: string
          id: string
          linked_project_id: string | null
          note_type: Database["public"]["Enums"]["note_type"]
          summary: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          id?: string
          linked_project_id?: string | null
          note_type?: Database["public"]["Enums"]["note_type"]
          summary?: string | null
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          content?: string | null
          created_at?: string
          id?: string
          linked_project_id?: string | null
          note_type?: Database["public"]["Enums"]["note_type"]
          summary?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      project_updates: {
        Row: {
          created_at: string
          id: string
          project_id: string
          update_text: string
          update_type: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          project_id: string
          update_text: string
          update_type?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          project_id?: string
          update_text?: string
          update_type?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_updates_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          blocker_summary: string | null
          created_at: string
          deadline: string | null
          description: string | null
          due_date: string | null
          id: string
          name: string | null
          next_action: string | null
          outcome: string | null
          priority: Database["public"]["Enums"]["project_priority"]
          slug: string | null
          start_date: string | null
          started_on: string
          status: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          blocker_summary?: string | null
          created_at?: string
          deadline?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          name?: string | null
          next_action?: string | null
          outcome?: string | null
          priority?: Database["public"]["Enums"]["project_priority"]
          slug?: string | null
          start_date?: string | null
          started_on?: string
          status?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          blocker_summary?: string | null
          created_at?: string
          deadline?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          name?: string | null
          next_action?: string | null
          outcome?: string | null
          priority?: Database["public"]["Enums"]["project_priority"]
          slug?: string | null
          start_date?: string | null
          started_on?: string
          status?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      reconciliation_matches: {
        Row: {
          confidence_score: number | null
          created_at: string
          id: string
          matched_transaction_id: string | null
          statement_id: string
          statement_transaction_hash: string | null
          status: Database["public"]["Enums"]["reconciliation_status"]
          user_id: string
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          id?: string
          matched_transaction_id?: string | null
          statement_id: string
          statement_transaction_hash?: string | null
          status?: Database["public"]["Enums"]["reconciliation_status"]
          user_id?: string
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          id?: string
          matched_transaction_id?: string | null
          statement_id?: string
          statement_transaction_hash?: string | null
          status?: Database["public"]["Enums"]["reconciliation_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_matches_matched_transaction_id_fkey"
            columns: ["matched_transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_matches_statement_id_fkey"
            columns: ["statement_id"]
            isOneToOne: false
            referencedRelation: "statements"
            referencedColumns: ["id"]
          },
        ]
      }
      statements: {
        Row: {
          confidence: number | null
          created_at: string
          credit_card_id: string | null
          file_path: string | null
          financial_account_id: string | null
          id: string
          loan_id: string | null
          parse_status: Database["public"]["Enums"]["parse_status"]
          period_end: string | null
          period_start: string | null
          reconciliation_status: Database["public"]["Enums"]["reconciliation_status"]
          source: string | null
          source_email_id: string | null
          statement_date: string | null
          statement_type: Database["public"]["Enums"]["statement_type"]
          transactions_found: number
          updated_at: string
          user_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          credit_card_id?: string | null
          file_path?: string | null
          financial_account_id?: string | null
          id?: string
          loan_id?: string | null
          parse_status?: Database["public"]["Enums"]["parse_status"]
          period_end?: string | null
          period_start?: string | null
          reconciliation_status?: Database["public"]["Enums"]["reconciliation_status"]
          source?: string | null
          source_email_id?: string | null
          statement_date?: string | null
          statement_type: Database["public"]["Enums"]["statement_type"]
          transactions_found?: number
          updated_at?: string
          user_id?: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          credit_card_id?: string | null
          file_path?: string | null
          financial_account_id?: string | null
          id?: string
          loan_id?: string | null
          parse_status?: Database["public"]["Enums"]["parse_status"]
          period_end?: string | null
          period_start?: string | null
          reconciliation_status?: Database["public"]["Enums"]["reconciliation_status"]
          source?: string | null
          source_email_id?: string | null
          statement_date?: string | null
          statement_type?: Database["public"]["Enums"]["statement_type"]
          transactions_found?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "statements_credit_card_id_fkey"
            columns: ["credit_card_id"]
            isOneToOne: false
            referencedRelation: "credit_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statements_financial_account_id_fkey"
            columns: ["financial_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statements_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statements_source_email_id_fkey"
            columns: ["source_email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          amount: number | null
          billing_cycle: string | null
          category: string | null
          created_at: string
          id: string
          linked_account_id: string | null
          linked_card_id: string | null
          name: string
          next_due_date: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount?: number | null
          billing_cycle?: string | null
          category?: string | null
          created_at?: string
          id?: string
          linked_account_id?: string | null
          linked_card_id?: string | null
          name: string
          next_due_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          amount?: number | null
          billing_cycle?: string | null
          category?: string | null
          created_at?: string
          id?: string
          linked_account_id?: string | null
          linked_card_id?: string | null
          name?: string
          next_due_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_linked_account_id_fkey"
            columns: ["linked_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_linked_card_id_fkey"
            columns: ["linked_card_id"]
            isOneToOne: false
            referencedRelation: "credit_cards"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          category: string | null
          created_at: string
          description: string | null
          due_at: string | null
          focus: boolean
          id: string
          linked_account_id: string | null
          linked_email_id: string | null
          linked_goal_id: string | null
          linked_project_id: string | null
          owner: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          reminder_at: string | null
          source: string | null
          status: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          description?: string | null
          due_at?: string | null
          focus?: boolean
          id?: string
          linked_account_id?: string | null
          linked_email_id?: string | null
          linked_goal_id?: string | null
          linked_project_id?: string | null
          owner?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          reminder_at?: string | null
          source?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          description?: string | null
          due_at?: string | null
          focus?: boolean
          id?: string
          linked_account_id?: string | null
          linked_email_id?: string | null
          linked_goal_id?: string | null
          linked_project_id?: string | null
          owner?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          reminder_at?: string | null
          source?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      threads: {
        Row: {
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      transactions: {
        Row: {
          amount: number
          category: string | null
          confidence: number | null
          confidence_score: number | null
          created_at: string
          credit_card_id: string | null
          description: string | null
          duplicate_group_id: string | null
          external_ref: string | null
          financial_account_id: string | null
          id: string
          is_reconciled: boolean
          loan_id: string | null
          merchant: string | null
          reference_number: string | null
          source: Database["public"]["Enums"]["txn_source"]
          source_email_id: string | null
          source_statement_id: string | null
          txn_date: string
          txn_type: Database["public"]["Enums"]["txn_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          category?: string | null
          confidence?: number | null
          confidence_score?: number | null
          created_at?: string
          credit_card_id?: string | null
          description?: string | null
          duplicate_group_id?: string | null
          external_ref?: string | null
          financial_account_id?: string | null
          id?: string
          is_reconciled?: boolean
          loan_id?: string | null
          merchant?: string | null
          reference_number?: string | null
          source?: Database["public"]["Enums"]["txn_source"]
          source_email_id?: string | null
          source_statement_id?: string | null
          txn_date: string
          txn_type: Database["public"]["Enums"]["txn_type"]
          updated_at?: string
          user_id?: string
        }
        Update: {
          amount?: number
          category?: string | null
          confidence?: number | null
          confidence_score?: number | null
          created_at?: string
          credit_card_id?: string | null
          description?: string | null
          duplicate_group_id?: string | null
          external_ref?: string | null
          financial_account_id?: string | null
          id?: string
          is_reconciled?: boolean
          loan_id?: string | null
          merchant?: string | null
          reference_number?: string | null
          source?: Database["public"]["Enums"]["txn_source"]
          source_email_id?: string | null
          source_statement_id?: string | null
          txn_date?: string
          txn_type?: Database["public"]["Enums"]["txn_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_credit_card_id_fkey"
            columns: ["credit_card_id"]
            isOneToOne: false
            referencedRelation: "credit_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_financial_account_id_fkey"
            columns: ["financial_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_source_email_id_fkey"
            columns: ["source_email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_source_statement_id_fkey"
            columns: ["source_statement_id"]
            isOneToOne: false
            referencedRelation: "statements"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      increment_jarvis_usage: {
        Args: { _requests?: number; _tokens?: number; _user_id: string }
        Returns: {
          requests: number
          tokens: number
        }[]
      }
      purge_old_jarvis_interactions: { Args: never; Returns: undefined }
    }
    Enums: {
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
      statement_type: ["account", "card", "loan"],
      task_priority: ["low", "normal", "high", "urgent"],
      task_status: ["todo", "doing", "waiting", "done", "cancelled"],
      txn_source: ["manual", "email", "statement", "import"],
      txn_type: ["debit", "credit", "transfer"],
    },
  },
} as const
