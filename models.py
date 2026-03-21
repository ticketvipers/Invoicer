from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any
import json


ADDON_TYPE_TO_ID = {
    "none": "1",
    "tax": "2",
    "shipping charge": "3",
    "drop charge": "4",
    "bottle deposit": "5",
    "other charge": "6",
    "discount": "7",
}


def resolve_addon_type_id(subtype: str, amount: str, existing_type_id: str) -> str:
    if existing_type_id:
        return existing_type_id

    s = (subtype or "").strip().lower()
    if not s:
        return ""

    # Exact controlled values first.
    if s in ADDON_TYPE_TO_ID:
        return ADDON_TYPE_TO_ID[s]

    # Deterministic keyword classification for provider-specific labels.
    if "tax" in s:
        return "2"
    if "ship" in s or "freight" in s or "delivery" in s:
        return "3"
    if "drop" in s:
        return "4"
    if "bottle" in s and "deposit" in s:
        return "5"

    amt = (amount or "").strip().replace(",", "")
    if "discount" in s or "off" in s or (amt.startswith("-") and amt != "-"):
        return "7"

    return "6"


@dataclass
class Addon:
    addonSubType: str = ""
    addonSubTypeId: str = ""
    amount: str = ""

    def to_dict(self) -> dict:
        return {
            "addonSubType": self.addonSubType,
            "addonSubTypeId": self.addonSubTypeId,
            "amount": self.amount,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Addon":
        if not isinstance(data, dict):
            return cls()
        subtype = str(
            data.get("addonsubType")
            or data.get("addonSubType")
            or data.get("AddonSubType")
            or ""
        )
        subtype_id = str(
            data.get("addonsubTypeId")
            or data.get("addonSubTypeId")
            or data.get("AddonSubTypeId")
            or ""
        )
        amount = str(data.get("amount") or "")
        subtype_id = resolve_addon_type_id(subtype, amount, subtype_id)
        return cls(
            addonSubType=subtype,
            addonSubTypeId=subtype_id,
            amount=amount,
        )


@dataclass
class Address:
    Name: str = ""
    Address1: str = ""
    Address2: str = ""
    AddressOther: str = ""
    City: str = ""
    State: str = ""
    Zip: str = ""
    Phone: str = ""
    Fax: str = ""

    def to_dict(self) -> dict:
        return {
            "Name": self.Name,
            "Address1": self.Address1,
            "Address2": self.Address2,
            "AddressOther": self.AddressOther,
            "City": self.City,
            "State": self.State,
            "Zip": self.Zip,
            "Phone": self.Phone,
            "Fax": self.Fax,
        }

    @classmethod
    def from_dict(cls, data: dict) -> Address:
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


@dataclass
class InvoiceHeader:
    InvoiceNumber: str = ""
    InvoiceDate: str = ""
    OrderNumber: str = ""
    OrderDate: str = ""
    Salesperson: str = ""
    CustomerNumber: str = ""
    CustomerPurchaseOrder: str = ""
    VendorAddress: Address = field(default_factory=Address)
    BillToAddress: Address = field(default_factory=Address)
    ShipToAddress: Address = field(default_factory=Address)
    VendorName: str = ""
    ShipMethod: str = ""
    Terms: str = ""

    def to_dict(self) -> dict:
        return {
            "InvoiceNumber": self.InvoiceNumber,
            "InvoiceDate": self.InvoiceDate,
            "OrderNumber": self.OrderNumber,
            "OrderDate": self.OrderDate,
            "Salesperson": self.Salesperson,
            "CustomerNumber": self.CustomerNumber,
            "CustomerPurchaseOrder": self.CustomerPurchaseOrder,
            "VendorAddress": self.VendorAddress.to_dict(),
            "BillToAddress": self.BillToAddress.to_dict(),
            "ShipToAddress": self.ShipToAddress.to_dict(),
            "VendorName": self.VendorName,
            "ShipMethod": self.ShipMethod,
            "Terms": self.Terms,
        }

    @classmethod
    def from_dict(cls, data: dict) -> InvoiceHeader:
        obj = cls()
        for k, v in data.items():
            if k in ("VendorAddress", "BillToAddress", "ShipToAddress"):
                setattr(obj, k, Address.from_dict(v) if isinstance(v, dict) else Address())
            elif k in cls.__dataclass_fields__:
                setattr(obj, k, v)
        return obj


@dataclass
class InvoiceLineItem:
    LineNumber: str = ""
    ItemName: str = ""
    ItemId: str = ""
    Unit: str = ""
    CatchWeight: str = ""
    QtyOrdered: str = ""
    QtyShipped: str = ""
    QtyBackOrdered: str = ""
    Price: str = ""
    ExtendedPrice: str = ""
    Addons: list[Addon] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "LineNumber": self.LineNumber,
            "ItemName": self.ItemName,
            "ItemId": self.ItemId,
            "Unit": self.Unit,
            "CatchWeight": self.CatchWeight,
            "QtyOrdered": self.QtyOrdered,
            "QtyShipped": self.QtyShipped,
            "QtyBackOrdered": self.QtyBackOrdered,
            "Price": self.Price,
            "ExtendedPrice": self.ExtendedPrice,
            "Addons": [a.to_dict() for a in self.Addons],
        }

    @classmethod
    def from_dict(cls, data: dict) -> InvoiceLineItem:
        kwargs = {k: v for k, v in data.items() if k in cls.__dataclass_fields__ and k != "Addons"}
        raw_addons = data.get("Addons")
        if raw_addons is None:
            raw_addons = data.get("addons")
        addons = [Addon.from_dict(a) for a in (raw_addons or []) if isinstance(a, dict)]
        return cls(**kwargs, Addons=addons)


@dataclass
class InvoiceDetails:
    InvoiceLineItems: list[InvoiceLineItem] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"InvoiceLineItems": [item.to_dict() for item in self.InvoiceLineItems]}

    @classmethod
    def from_dict(cls, data: dict) -> InvoiceDetails:
        items = [
            InvoiceLineItem.from_dict(i) if isinstance(i, dict) else i
            for i in data.get("InvoiceLineItems", [])
        ]
        return cls(InvoiceLineItems=items)


@dataclass
class InvoiceFooter:
    Subtotal: str = ""
    Total: str = ""
    Addons: list[Addon] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"Subtotal": self.Subtotal, "Total": self.Total, "Addons": [a.to_dict() for a in self.Addons]}

    @classmethod
    def from_dict(cls, data: dict) -> InvoiceFooter:
        raw_addons = data.get("Addons")
        if raw_addons is None:
            raw_addons = data.get("addons")
        addons = [Addon.from_dict(a) for a in (raw_addons or []) if isinstance(a, dict)]
        return cls(
            Subtotal=data.get("Subtotal", ""),
            Total=data.get("Total", ""),
            Addons=addons,
        )


@dataclass
class InvoiceModel:
    Header: InvoiceHeader = field(default_factory=InvoiceHeader)
    Details: InvoiceDetails = field(default_factory=InvoiceDetails)
    Footer: InvoiceFooter = field(default_factory=InvoiceFooter)

    def to_dict(self) -> dict:
        return {
            "Header": self.Header.to_dict(),
            "Details": self.Details.to_dict(),
            "Footer": self.Footer.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> InvoiceModel:
        return cls(
            Header=InvoiceHeader.from_dict(data.get("Header", {})),
            Details=InvoiceDetails.from_dict(data.get("Details", {})),
            Footer=InvoiceFooter.from_dict(data.get("Footer", {})),
        )


@dataclass
class InvoiceRecord:
    InvoiceModel: InvoiceModel = field(default_factory=InvoiceModel)
    pdfContent: str = ""
    invoiceStatus: str = "1"
    resultMessage: str = ""
    pageRanges: list[Any] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "InvoiceModel": self.InvoiceModel.to_dict(),
            "pdfContent": self.pdfContent,
            "invoiceStatus": self.invoiceStatus,
            "resultMessage": self.resultMessage,
            "pageRanges": self.pageRanges,
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, data: dict) -> InvoiceRecord:
        return cls(
            InvoiceModel=InvoiceModel.from_dict(data.get("InvoiceModel", {})),
            pdfContent=data.get("pdfContent", ""),
            invoiceStatus=data.get("invoiceStatus", "1"),
            resultMessage=data.get("resultMessage", ""),
            pageRanges=data.get("pageRanges", []),
        )

    @classmethod
    def from_json(cls, json_str: str) -> InvoiceRecord:
        data = json.loads(json_str)
        if isinstance(data, list):
            data = data[0]
        return cls.from_dict(data)


@dataclass
class InvoiceBatch:
    """Represents the top-level list of invoice records matching the schema."""
    records: list[InvoiceRecord] = field(default_factory=list)

    def to_list(self) -> list[dict]:
        return [r.to_dict() for r in self.records]

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_list(), indent=indent)

    @classmethod
    def from_list(cls, data: list[dict]) -> InvoiceBatch:
        return cls(records=[InvoiceRecord.from_dict(r) for r in data])

    @classmethod
    def from_json(cls, json_str: str) -> InvoiceBatch:
        data = json.loads(json_str)
        if isinstance(data, dict):
            data = [data]
        return cls.from_list(data)

    def append(self, record: InvoiceRecord) -> None:
        self.records.append(record)

    def __len__(self) -> int:
        return len(self.records)

    def __iter__(self):
        return iter(self.records)

    def __getitem__(self, index: int) -> InvoiceRecord:
        return self.records[index]