--
-- PostgreSQL database dump
--

\restrict Q3fvXm6cb8sRxP9LkhqxhEagO7etG4Kk8dSXUdP4oCgDWDllMCHI4jOkMsswxdz

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: camera_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.camera_status AS ENUM (
    'offline',
    'online',
    'error',
    'paused'
);


--
-- Name: event_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_kind AS ENUM (
    'detection',
    'match',
    'unknown',
    'alert',
    'health'
);


--
-- Name: person_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.person_role AS ENUM (
    'student',
    'staff',
    'faculty',
    'visitor',
    'blacklist',
    'unknown'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid NOT NULL,
    tenant_id uuid,
    actor character varying(128) NOT NULL,
    actor_kind character varying(32) NOT NULL,
    action character varying(64) NOT NULL,
    target_type character varying(64),
    target_id character varying(128),
    reason character varying(256),
    metadata json,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: camera_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.camera_edges (
    tenant_id uuid NOT NULL,
    from_camera uuid NOT NULL,
    to_camera uuid NOT NULL,
    t_min_sec integer DEFAULT 1 NOT NULL,
    t_max_sec integer DEFAULT 300 NOT NULL,
    prob double precision DEFAULT '0.5'::double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cameras; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cameras (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    code character varying(64) NOT NULL,
    name character varying(256) NOT NULL,
    rtsp_url text NOT NULL,
    location character varying(256),
    zone character varying(128),
    status public.camera_status DEFAULT 'offline'::public.camera_status NOT NULL,
    target_fps double precision DEFAULT '8'::double precision NOT NULL,
    detection_input_size integer DEFAULT 640 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_seen_at timestamp with time zone,
    config json,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lat double precision,
    lng double precision,
    building character varying(128),
    floor character varying(64),
    orientation double precision
);


--
-- Name: detection_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.detection_events (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    camera_id uuid NOT NULL,
    track_id character varying(64) NOT NULL,
    kind public.event_kind NOT NULL,
    person_id uuid,
    similarity double precision,
    det_score double precision,
    quality_score double precision,
    bbox json,
    snapshot_uri text,
    extra json,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.embeddings (
    detection_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    face_vec public.vector(512),
    body_vec public.vector(512),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: face_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.face_enrollments (
    id uuid NOT NULL,
    person_id uuid NOT NULL,
    qdrant_point_id uuid NOT NULL,
    snapshot_uri text,
    det_score double precision,
    quality_score double precision,
    source character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: face_learning_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.face_learning_samples (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    camera_id uuid,
    event_id uuid,
    track_id character varying(64),
    qdrant_point_id uuid,
    snapshot_uri text,
    bbox json,
    embedding json NOT NULL,
    similarity double precision,
    det_score double precision,
    quality_score double precision,
    gender character varying(16),
    status character varying(24) DEFAULT 'pending'::character varying NOT NULL,
    reason character varying(256),
    reviewed_by character varying(128),
    reviewed_at timestamp with time zone,
    metadata json,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: footfall_minute_buckets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.footfall_minute_buckets (
    tenant_id uuid NOT NULL,
    camera_id uuid NOT NULL,
    bucket_minute timestamp with time zone NOT NULL,
    in_count integer DEFAULT 0 NOT NULL,
    out_count integer DEFAULT 0 NOT NULL,
    falls_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: journey_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journey_stops (
    id uuid NOT NULL,
    journey_id uuid NOT NULL,
    seq integer NOT NULL,
    camera_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    confidence double precision,
    snapshot_uri text,
    detection_count integer DEFAULT 0 NOT NULL
);


--
-- Name: journeys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journeys (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    person_id uuid,
    created_by character varying(128),
    mode character varying(16) DEFAULT 'forensic'::character varying NOT NULL,
    window_start timestamp with time zone,
    window_end timestamp with time zone,
    first_seen_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    cameras_count integer DEFAULT 0 NOT NULL,
    confidence double precision,
    graph jsonb,
    video_uri text,
    report_uri text,
    status character varying(16) DEFAULT 'building'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: persons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.persons (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    external_id character varying(128),
    full_name character varying(256) NOT NULL,
    role public.person_role DEFAULT 'unknown'::public.person_role NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata json,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid NOT NULL,
    name character varying(128) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: track_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.track_links (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    a_track_id character varying(64) NOT NULL,
    a_camera_id uuid NOT NULL,
    a_event_id uuid,
    a_occurred_at timestamp with time zone NOT NULL,
    b_track_id character varying(64) NOT NULL,
    b_camera_id uuid NOT NULL,
    b_event_id uuid,
    b_occurred_at timestamp with time zone NOT NULL,
    similarity double precision NOT NULL,
    link_kind character varying(32) DEFAULT 'cosine_face'::character varying NOT NULL,
    person_id uuid,
    metadata json,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: camera_edges camera_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camera_edges
    ADD CONSTRAINT camera_edges_pkey PRIMARY KEY (from_camera, to_camera);


--
-- Name: cameras cameras_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cameras
    ADD CONSTRAINT cameras_pkey PRIMARY KEY (id);


--
-- Name: detection_events detection_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.detection_events
    ADD CONSTRAINT detection_events_pkey PRIMARY KEY (id);


--
-- Name: embeddings embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_pkey PRIMARY KEY (detection_id);


--
-- Name: face_enrollments face_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.face_enrollments
    ADD CONSTRAINT face_enrollments_pkey PRIMARY KEY (id);


--
-- Name: face_enrollments face_enrollments_qdrant_point_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.face_enrollments
    ADD CONSTRAINT face_enrollments_qdrant_point_id_key UNIQUE (qdrant_point_id);


--
-- Name: face_learning_samples face_learning_samples_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.face_learning_samples
    ADD CONSTRAINT face_learning_samples_event_id_key UNIQUE (event_id);


--
-- Name: face_learning_samples face_learning_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.face_learning_samples
    ADD CONSTRAINT face_learning_samples_pkey PRIMARY KEY (id);


--
-- Name: face_learning_samples face_learning_samples_qdrant_point_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.face_learning_samples
    ADD CONSTRAINT face_learning_samples_qdrant_point_id_key UNIQUE (qdrant_point_id);


--
-- Name: journey_stops journey_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_stops
    ADD CONSTRAINT journey_stops_pkey PRIMARY KEY (id);


--
-- Name: journeys journeys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journeys
    ADD CONSTRAINT journeys_pkey PRIMARY KEY (id);


--
-- Name: persons persons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT persons_pkey PRIMARY KEY (id);


--
-- Name: footfall_minute_buckets pk_footfall_minute_buckets; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.footfall_minute_buckets
    ADD CONSTRAINT pk_footfall_minute_buckets PRIMARY KEY (camera_id, bucket_minute);


--
-- Name: tenants tenants_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_name_key UNIQUE (name);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: track_links track_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.track_links
    ADD CONSTRAINT track_links_pkey PRIMARY KEY (id);


--
-- Name: cameras uq_camera_tenant_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cameras
    ADD CONSTRAINT uq_camera_tenant_code UNIQUE (tenant_id, code);


--
-- Name: journey_stops uq_journey_stop_seq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_stops
    ADD CONSTRAINT uq_journey_stop_seq UNIQUE (journey_id, seq);


--
-- Name: persons uq_person_tenant_external; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT uq_person_tenant_external UNIQUE (tenant_id, external_id);


--
-- Name: track_links uq_track_link_pair; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.track_links
    ADD CONSTRAINT uq_track_link_pair UNIQUE (a_track_id, a_camera_id, b_track_id, b_camera_id);


--
-- Name: camera_edges_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX camera_edges_tenant_idx ON public.camera_edges USING btree (tenant_id);


--
-- Name: embeddings_body_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX embeddings_body_hnsw ON public.embeddings USING hnsw (body_vec public.vector_cosine_ops);


--
-- Name: embeddings_face_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX embeddings_face_hnsw ON public.embeddings USING hnsw (face_vec public.vector_cosine_ops);


--
-- Name: embeddings_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX embeddings_tenant_idx ON public.embeddings USING btree (tenant_id);


--
-- Name: ix_audit_log_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_log_action ON public.audit_log USING btree (action);


--
-- Name: ix_audit_log_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_log_actor ON public.audit_log USING btree (actor);


--
-- Name: ix_audit_log_actor_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_log_actor_kind ON public.audit_log USING btree (actor_kind);


--
-- Name: ix_audit_log_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_log_occurred_at ON public.audit_log USING btree (occurred_at);


--
-- Name: ix_audit_log_target_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_log_target_id ON public.audit_log USING btree (target_id);


--
-- Name: ix_audit_log_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_log_tenant_id ON public.audit_log USING btree (tenant_id);


--
-- Name: ix_cameras_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cameras_code ON public.cameras USING btree (code);


--
-- Name: ix_cameras_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cameras_tenant_id ON public.cameras USING btree (tenant_id);


--
-- Name: ix_detection_events_camera_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_detection_events_camera_id ON public.detection_events USING btree (camera_id);


--
-- Name: ix_detection_events_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_detection_events_kind ON public.detection_events USING btree (kind);


--
-- Name: ix_detection_events_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_detection_events_occurred_at ON public.detection_events USING btree (occurred_at);


--
-- Name: ix_detection_events_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_detection_events_person_id ON public.detection_events USING btree (person_id);


--
-- Name: ix_detection_events_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_detection_events_tenant_id ON public.detection_events USING btree (tenant_id);


--
-- Name: ix_detection_events_track_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_detection_events_track_id ON public.detection_events USING btree (track_id);


--
-- Name: ix_face_enrollments_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_face_enrollments_person_id ON public.face_enrollments USING btree (person_id);


--
-- Name: ix_face_learning_samples_camera_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_face_learning_samples_camera_id ON public.face_learning_samples USING btree (camera_id);


--
-- Name: ix_face_learning_samples_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_face_learning_samples_occurred_at ON public.face_learning_samples USING btree (occurred_at);


--
-- Name: ix_face_learning_samples_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_face_learning_samples_person_id ON public.face_learning_samples USING btree (person_id);


--
-- Name: ix_face_learning_samples_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_face_learning_samples_status ON public.face_learning_samples USING btree (status);


--
-- Name: ix_face_learning_samples_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_face_learning_samples_tenant_id ON public.face_learning_samples USING btree (tenant_id);


--
-- Name: ix_face_learning_samples_track_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_face_learning_samples_track_id ON public.face_learning_samples USING btree (track_id);


--
-- Name: ix_footfall_minute_buckets_camera_time_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_footfall_minute_buckets_camera_time_desc ON public.footfall_minute_buckets USING btree (camera_id, bucket_minute DESC);


--
-- Name: ix_footfall_minute_buckets_tenant_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_footfall_minute_buckets_tenant_time ON public.footfall_minute_buckets USING btree (tenant_id, bucket_minute);


--
-- Name: ix_persons_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_persons_external_id ON public.persons USING btree (external_id);


--
-- Name: ix_persons_full_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_persons_full_name ON public.persons USING btree (full_name);


--
-- Name: ix_persons_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_persons_tenant_id ON public.persons USING btree (tenant_id);


--
-- Name: ix_track_links_a_camera_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_track_links_a_camera_id ON public.track_links USING btree (a_camera_id);


--
-- Name: ix_track_links_a_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_track_links_a_occurred_at ON public.track_links USING btree (a_occurred_at);


--
-- Name: ix_track_links_a_track_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_track_links_a_track_id ON public.track_links USING btree (a_track_id);


--
-- Name: ix_track_links_b_camera_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_track_links_b_camera_id ON public.track_links USING btree (b_camera_id);


--
-- Name: ix_track_links_b_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_track_links_b_occurred_at ON public.track_links USING btree (b_occurred_at);


--
-- Name: ix_track_links_b_track_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_track_links_b_track_id ON public.track_links USING btree (b_track_id);


--
-- Name: ix_track_links_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_track_links_person_id ON public.track_links USING btree (person_id);


--
-- Name: ix_track_links_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_track_links_tenant_id ON public.track_links USING btree (tenant_id);


--
-- Name: journey_stops_journey_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journey_stops_journey_idx ON public.journey_stops USING btree (journey_id);


--
-- Name: journeys_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journeys_created_idx ON public.journeys USING btree (created_at);


--
-- Name: journeys_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journeys_person_idx ON public.journeys USING btree (person_id);


--
-- Name: journeys_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journeys_tenant_idx ON public.journeys USING btree (tenant_id);


--
-- Name: camera_edges camera_edges_from_camera_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camera_edges
    ADD CONSTRAINT camera_edges_from_camera_fkey FOREIGN KEY (from_camera) REFERENCES public.cameras(id) ON DELETE CASCADE;


--
-- Name: camera_edges camera_edges_to_camera_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camera_edges
    ADD CONSTRAINT camera_edges_to_camera_fkey FOREIGN KEY (to_camera) REFERENCES public.cameras(id) ON DELETE CASCADE;


--
-- Name: cameras cameras_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cameras
    ADD CONSTRAINT cameras_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: detection_events detection_events_camera_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.detection_events
    ADD CONSTRAINT detection_events_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES public.cameras(id) ON DELETE CASCADE;


--
-- Name: detection_events detection_events_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.detection_events
    ADD CONSTRAINT detection_events_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.persons(id) ON DELETE SET NULL;


--
-- Name: embeddings embeddings_detection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_detection_id_fkey FOREIGN KEY (detection_id) REFERENCES public.detection_events(id) ON DELETE CASCADE;


--
-- Name: face_enrollments face_enrollments_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.face_enrollments
    ADD CONSTRAINT face_enrollments_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.persons(id) ON DELETE CASCADE;


--
-- Name: face_learning_samples face_learning_samples_camera_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.face_learning_samples
    ADD CONSTRAINT face_learning_samples_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES public.cameras(id) ON DELETE SET NULL;


--
-- Name: face_learning_samples face_learning_samples_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.face_learning_samples
    ADD CONSTRAINT face_learning_samples_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.detection_events(id) ON DELETE SET NULL;


--
-- Name: face_learning_samples face_learning_samples_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.face_learning_samples
    ADD CONSTRAINT face_learning_samples_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.persons(id) ON DELETE CASCADE;


--
-- Name: footfall_minute_buckets footfall_minute_buckets_camera_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.footfall_minute_buckets
    ADD CONSTRAINT footfall_minute_buckets_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES public.cameras(id) ON DELETE CASCADE;


--
-- Name: journey_stops journey_stops_camera_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_stops
    ADD CONSTRAINT journey_stops_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES public.cameras(id) ON DELETE CASCADE;


--
-- Name: journey_stops journey_stops_journey_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_stops
    ADD CONSTRAINT journey_stops_journey_id_fkey FOREIGN KEY (journey_id) REFERENCES public.journeys(id) ON DELETE CASCADE;


--
-- Name: journeys journeys_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journeys
    ADD CONSTRAINT journeys_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.persons(id) ON DELETE SET NULL;


--
-- Name: persons persons_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT persons_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict Q3fvXm6cb8sRxP9LkhqxhEagO7etG4Kk8dSXUdP4oCgDWDllMCHI4jOkMsswxdz

