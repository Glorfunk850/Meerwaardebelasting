from decimal import Decimal as D

import pytest

from web.app import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path / "test.db")
    app.testing = True
    return app.test_client()


def post_tx(client, **kw):
    r = client.post("/api/transactions", json=kw)
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def seed_example(client):
    post_tx(client, type="BUY", trade_date="2024-05-01", asset="x", quantity="100", price="50", historic_proven=True)
    post_tx(client, type="BUY", trade_date="2025-05-01", asset="X", quantity="50", price="120", historic_proven=True)
    post_tx(client, type="BUY", trade_date="2026-03-01", asset="X", quantity="50", price="90")
    post_tx(client, type="SELL", trade_date="2026-09-01", asset="X", quantity="120", price="110", fees="7,50")
    post_tx(client, type="BUY", trade_date="2026-02-01", asset="Y", quantity="200", price="30")
    post_tx(client, type="SELL", trade_date="2026-11-01", asset="Y", quantity="200", price="25")


def test_full_flow_matches_worked_example(client):
    seed_example(client)
    # zonder fotowaarde kan niet gerekend worden
    r = client.get("/api/report")
    assert r.status_code == 422 and "31/12/2025" in r.get_json()["error"]

    assets = {a["isin"]: a for a in client.get("/api/assets").get_json()}
    assert assets["X"]["needs_ref"] and not assets["Y"]["needs_ref"]
    assert client.put("/api/assets/X", json={"ref_value_eur": "80", "name": "Aandeel X"}).status_code == 200
    assert client.put("/api/withheld", json={"owner": "default", "year": 2026, "amount": "360"}).status_code == 200

    rep = client.get("/api/report").get_json()
    y = rep["years"][0]
    assert (y["net_eur"], y["taxable_eur"], y["refund_eur"]) == ("2000.00", "0.00", "360.00")
    sale_x = next(s for s in rep["sales"] if s["asset"] == "X")
    assert [l["basis_used"] for l in sale_x["lines"]] == ["REF_31_12_2025", "HISTORISCH"]
    assert sale_x["fees_eur"] == "7.50"
    assert rep["disclaimer"]


def test_alternative_method_shown_when_different(client):
    seed_example(client)
    client.put("/api/assets/X", json={"ref_value_eur": "80"})
    y = client.get("/api/report").get_json()["years"][0]
    # netto verschilt (2000 vs 2600) -> alternatief getoond
    assert y["alternative"] == {"method": "GEMIDDELD", "net_eur": "2600.00", "tax_eur": "0.00"}

    client.put("/api/settings", json={"historic_method": "GEMIDDELD"})
    y = client.get("/api/report").get_json()["years"][0]
    assert y["net_eur"] == "2600.00" and y["alternative"]["method"] == "FIFO"


def test_validation_errors(client):
    r = client.post("/api/transactions", json={"type": "BUY", "trade_date": "2026-01-01", "asset": "A", "quantity": "-1", "price": "1"})
    assert r.status_code == 400 and "groter dan 0" in r.get_json()["error"]
    r = client.post("/api/transactions", json={"type": "XXX", "trade_date": "2026-01-01", "asset": "A"})
    assert r.status_code == 400
    r = client.post("/api/transactions", json={"type": "SELL", "trade_date": "01/02/2026", "asset": "A", "quantity": "1", "price": "1"})
    assert "JJJJ-MM-DD" in r.get_json()["error"]
    r = client.post("/api/transactions", json={"type": "BUY", "trade_date": "2026-01-01", "asset": "A", "quantity": "1", "price": "abc"})
    assert "geen geldig getal" in r.get_json()["error"]
    r = client.post("/api/transactions", json={"type": "BUY", "trade_date": "2026-01-01", "asset": "A", "quantity": "1", "price": "1", "fx_per_eur": "1.1"})
    assert "EUR" in r.get_json()["error"]
    assert client.put("/api/settings", json={"fifo_scope": "NOPE"}).status_code == 400


def test_missing_year_config_reported(client):
    post_tx(client, type="BUY", trade_date="2026-01-05", asset="A", quantity="1", price="10")
    post_tx(client, type="SELL", trade_date="2027-02-01", asset="A", quantity="1", price="20")
    r = client.get("/api/report")
    assert r.status_code == 422 and "2027" in r.get_json()["error"]
    client.put("/api/years/2027", json={"rate": "0.10", "base_exemption": "10200", "carry_slice": "1000"})
    assert client.get("/api/report").status_code == 200


def test_update_delete_and_filters(client):
    t = post_tx(client, type="BUY", trade_date="2026-01-05", asset="A", quantity="1", price="10", owner="an")
    post_tx(client, type="BUY", trade_date="2026-01-05", asset="B", quantity="1", price="10", owner="bert")
    assert len(client.get("/api/transactions?owner=an").get_json()) == 1
    r = client.put(f"/api/transactions/{t['id']}", json={**t, "price": "12.345"})
    assert r.get_json()["price"] == "12.345"
    assert client.delete(f"/api/transactions/{t['id']}").status_code == 204
    assert client.delete(f"/api/transactions/{t['id']}").status_code == 404
    assert client.delete("/api/assets/B").status_code == 409


def test_split_dividend_and_csv(client):
    post_tx(client, type="BUY", trade_date="2026-01-05", asset="S", quantity="10", price="100", currency="USD", fx_per_eur="1.25")
    post_tx(client, type="SPLIT", trade_date="2026-03-01", asset="S", split_ratio="4")
    post_tx(client, type="DIVIDEND", trade_date="2026-04-01", asset="S", amount="25", currency="USD", fx_per_eur="1.25")
    post_tx(client, type="SELL", trade_date="2026-06-01", asset="S", quantity="40", price="25", currency="USD", fx_per_eur="1.25")
    rep = client.get("/api/report").get_json()
    assert rep["sales"][0]["result_eur"] == "0.00"
    assert rep["years"][0]["dividends_eur"] == "20.00"
    csv = client.get("/api/report/sales.csv").get_data(as_text=True)
    assert "verkoopdatum" in csv and "2026-06-01" in csv


def test_frontend_served(client):
    assert b"Meerwaardebelasting" in client.get("/").data
    assert client.get("/static/app.js").status_code == 200
