# -*- coding: utf-8 -*-
"""Fillable client scoping / brief form for a branding + website quotation."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor, white
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth

OUT = "Project-Brief-Scoping-Form.pdf"

W, H = A4
M = 44.0                 # page margin
CW = W - 2 * M           # content width

NAVY   = HexColor("#14304F")
ACCENT = HexColor("#1F6F8B")
INK    = HexColor("#1C1C1C")
MUTED  = HexColor("#6B7280")
RULE   = HexColor("#D5DCE5")
BAND   = HexColor("#EEF2F6")
FIELDB = HexColor("#F7F9FB")

TOP = H - M
BOTTOM = M + 30          # reserve room for the page footer

c = canvas.Canvas(OUT, pagesize=A4)
c.setTitle("Project Brief & Scoping Form")
c.setSubject("Branding and website design - client scoping form")
c.setAuthor("[Your Company Name]")

form = c.acroForm
y = [TOP]                # mutable cursor
page_no = [1]
_uid = [0]
cur_sec = [""]


def uid(prefix):
    _uid[0] += 1
    return "%s_%d" % (prefix, _uid[0])


def page_footer():
    c.setStrokeColor(RULE)
    c.setLineWidth(0.6)
    c.line(M, M + 22, W - M, M + 22)
    c.setFont("Helvetica", 7.5)
    c.setFillColor(MUTED)
    c.drawString(M, M + 12, "Project Brief & Scoping Form  •  Branding & Website Design")
    c.drawRightString(W - M, M + 12, "Page %d" % page_no[0])


def new_page():
    page_footer()
    c.showPage()
    page_no[0] += 1
    y[0] = TOP
    # continuation header
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(NAVY)
    c.drawString(M, y[0] - 8, "PROJECT BRIEF & SCOPING FORM")
    c.setFont("Helvetica", 8)
    c.setFillColor(MUTED)
    tail = ("%s (continued)" % cur_sec[0]) if cur_sec[0] else "continued"
    c.drawRightString(W - M, y[0] - 8, tail)
    c.setStrokeColor(RULE)
    c.setLineWidth(0.6)
    c.line(M, y[0] - 15, W - M, y[0] - 15)
    y[0] -= 32


def need(h):
    if y[0] - h < BOTTOM:
        new_page()


def section(number, title, keep=0):
    need(46 + keep)
    cur_sec[0] = "%s. %s" % (number, title)
    y[0] -= 6
    h = 19
    c.setFillColor(BAND)
    c.rect(M, y[0] - h, CW, h, stroke=0, fill=1)
    c.setFillColor(NAVY)
    c.rect(M, y[0] - h, 3.2, h, stroke=0, fill=1)
    c.setFont("Helvetica-Bold", 9.5)
    c.setFillColor(NAVY)
    c.drawString(M + 11, y[0] - h + 6.4, "%s.  %s" % (number, title.upper()))
    y[0] -= h + 9


def question(text, gap=2):
    need(38)
    c.setFont("Helvetica-Bold", 8.6)
    c.setFillColor(INK)
    c.drawString(M, y[0] - 8, text)
    y[0] -= 8 + gap + 3


def note(text, gap=11):
    need(16)
    c.setFont("Helvetica-Oblique", 7.6)
    c.setFillColor(MUTED)
    c.drawString(M, y[0] - 7, text)
    y[0] -= 7 + gap


def textfield(x, ypos, w, h, name, value="", multiline=False, size=9):
    form.textfield(
        name=name, tooltip=name, value=value,
        x=x, y=ypos, width=w, height=h,
        borderStyle="solid", borderWidth=0.7, borderColor=RULE,
        fillColor=FIELDB, textColor=INK, forceBorder=True,
        fontName="Helvetica", fontSize=size,
        fieldFlags="multiline" if multiline else "",
    )


def labelled_fields(rows, fh=17, label_gap=9.5, row_gap=6):
    """rows: list of lists of (label, relative_width)."""
    for row in rows:
        need(fh + label_gap + row_gap)
        total = sum(r[1] for r in row)
        gap = 10.0
        avail = CW - gap * (len(row) - 1)
        x = M
        for label, wt in row:
            fw = avail * wt / total
            c.setFont("Helvetica", 7.6)
            c.setFillColor(MUTED)
            c.drawString(x + 1, y[0] - 7, label.upper())
            textfield(x, y[0] - label_gap - fh, fw, fh, uid("f"))
            x += fw + gap
        y[0] -= label_gap + fh + row_gap


def checks(items, cols=None, box=9.0, rowh=14.5, fs=8.4, trail=5):
    """items: list of label strings, or (label, 'inline_field_width') tuples."""
    norm = []
    for it in items:
        if isinstance(it, tuple):
            norm.append((it[0], it[1]))
        else:
            norm.append((it, 0))

    if cols:
        colw = CW / cols
        lines = [norm[i:i + cols] for i in range(0, len(norm), cols)]
    else:
        lines, cur, used = [], [], 0.0
        for lab, extra in norm:
            wneed = box + 5 + stringWidth(lab, "Helvetica", fs) + extra + 20
            if cur and used + wneed > CW:
                lines.append(cur)
                cur, used = [], 0.0
            cur.append((lab, extra))
            used += wneed
        if cur:
            lines.append(cur)
        colw = None

    for line in lines:
        need(rowh + 2)
        x = M
        for lab, extra in line:
            form.checkbox(
                name=uid("cb"), tooltip=lab, x=x, y=y[0] - box - 1.5, size=box,
                buttonStyle="check", shape="square",
                borderWidth=0.7, borderColor=HexColor("#9AA7B5"),
                fillColor=white, textColor=NAVY,
            )
            c.setFont("Helvetica", fs)
            c.setFillColor(INK)
            c.drawString(x + box + 5, y[0] - box + 0.9, lab)
            adv = box + 5 + stringWidth(lab, "Helvetica", fs)
            if extra:
                textfield(x + adv + 4, y[0] - box - 2.5, extra, box + 2.5, uid("f"), size=8)
                adv += extra + 4
            x += colw if colw else adv + 20
        y[0] -= rowh
    y[0] -= trail


# ----------------------------------------------------------------- header ---
c.setFillColor(NAVY)
c.rect(M, TOP - 3, 34, 3, stroke=0, fill=1)

c.setFont("Helvetica-Bold", 7.6)
c.setFillColor(ACCENT)
c.drawString(M, TOP - 20, "P R O J E C T   B R I E F")

c.setFont("Helvetica-Bold", 19)
c.setFillColor(NAVY)
c.drawString(M, TOP - 42, "Branding & Website Scoping Form")

c.setFont("Helvetica", 9)
c.setFillColor(MUTED)
c.drawString(M, TOP - 56, "Logo  •  Email signatures  •  Letterhead  •  Website  •  Virtual business cards")

# right-hand company placeholder
c.setFont("Helvetica-Bold", 9)
c.setFillColor(INK)
c.drawRightString(W - M, TOP - 20, "[YOUR COMPANY NAME]")
c.setFont("Helvetica", 7.6)
c.setFillColor(MUTED)
c.drawRightString(W - M, TOP - 31, "[Telephone]  •  [Email]")
c.drawRightString(W - M, TOP - 41, "[Website]")

c.setStrokeColor(NAVY)
c.setLineWidth(1.2)
c.line(M, TOP - 66, W - M, TOP - 66)

y[0] = TOP - 82

intro = [
    "Thank you for your enquiry. Completing this short form allows us to prepare an accurate, itemised quotation rather than a broad",
    "estimate. Kindly tick the applicable boxes and complete the fields — there are no wrong answers, and “not sure” is perfectly acceptable.",
]
c.setFont("Helvetica", 8.6)
c.setFillColor(INK)
for ln in intro:
    c.drawString(M, y[0] - 8, ln)
    y[0] -= 11
y[0] -= 4

# ---------------------------------------------------------------- content ---
section("1", "Your details")
labelled_fields([
    [("Company / organisation name", 2), ("Industry or sector", 1)],
    [("Contact person", 1), ("Position", 1), ("Telephone", 1)],
    [("Email address", 1.2), ("Existing website, if any", 1), ("How did you hear about us?", 1)],
])

section("2", "Logo & brand identity")
question("Which best describes your requirement?")
checks(["New logo, designed from scratch",
        "Refresh / modernise our existing logo",
        "We already have a logo — we need the other items only"])

question("Do you have existing brand colours, fonts or artwork?")
checks(["Yes — attached to this email", "Yes — will send separately", "No — starting fresh"])

question("Preferred style (tick any that appeal)")
checks(["Modern & minimal", "Classic & formal", "Bold & striking",
        "Corporate & professional", "Friendly & approachable", "Not sure — please guide us"], cols=3)

question("Brands or logos you admire, and what appeals to you about them")
need(34)
textfield(M, y[0] - 26, CW, 26, uid("f"), multiline=True, size=8.5)
y[0] -= 34

section("3", "Website")
question("You already have a website. What would you like done with it?")
checks(["Redesign it — new look, existing content",
        "Redesign and rewrite — new look, new content",
        "Rebuild it on a new platform",
        "Leave it as is — we need the other items only"])

question("Roughly how many pages does the current site have?")
checks(["Under 10", "10 – 25", "26 – 50", "More than 50", "Not sure"])

labelled_fields([
    [("What is it currently built on? (WordPress, Wix, custom — or 'not sure')", 2),
     ("Who currently maintains it / holds the login?", 1.4)],
])

question("Which of these are true of the current site? (tick any)")
checks(["We receive enquiries through it",
        "We rank well on Google for certain searches",
        "We cannot update it ourselves",
        "Not sure"])
note("Where a site already ranks, we preserve every existing web address and redirect the old pages to the new ones, so that established search rankings and any links pointing to you are carried across rather than lost.")

question("What should the website primarily achieve?")
checks(["Establish a professional online presence", "Generate enquiries / leads",
        "Take online bookings", "Sell products online", "Not sure yet"])

question("Approximate number of pages for the new site")
checks(["One page", "3 – 5 pages", "6 – 10 pages", "11 – 25 pages", "More than 25", "Not sure"])

labelled_fields([
    [("How many individual team / staff profile pages?", 1),
     ("How many service or specialisation pages?", 1)],
])
note("These two numbers are the largest single driver of the website cost — a best estimate is fine.")

question("Any pages to add, remove or merge compared with the current site?")
need(30)
textfield(M, y[0] - 24, CW, 24, uid("f"), multiline=True, size=8.5)
y[0] -= 32

question("Written content and photographs")
checks(["We will supply all text and images",
        "We will supply the text; please source images",
        "Please provide copywriting and images"])

question("Domain name and hosting")
checks([("Domain already registered:", 130), "Hosting already in place", "Neither — please arrange"])

question("Would you like to update the website content yourselves?")
checks(["Yes", "No", "Not sure"])

question("Compliance and policy pages required (tick any)")
checks(["Privacy notice (POPIA)", "PAIA manual or access request page",
        "Terms of use", "Cookie notice", "Complaints procedure",
        "Not sure — please advise"], cols=3)
note("We will draft the page structure and standard wording; final approval of any legal text rests with you.")

question("Features required (tick any)")
checks(["Contact / enquiry form", "Google Maps location", "Photo gallery",
        "Blog / news section", "Online booking", "Client login area",
        "Newsletter sign-up", "WhatsApp / live chat", "Online payments",
        "Multi-language", "Downloadable documents", ("Other:", 90)], cols=3)

section("4", "Email signatures & virtual business cards")
labelled_fields([
    [("Number of staff requiring email signatures", 1), ("Number requiring virtual business cards", 1)],
])
question("Which email platform do you use?")
checks(["Microsoft 365 / Outlook", "Google Workspace / Gmail", ("Other:", 100), "Not sure"])

section("5", "Letterhead & stationery")
question("What format do you require?")
checks(["Print-ready artwork for a commercial printer",
        "Word / PDF template for internal use",
        "Both"])
question("Matching templates required (tick any)")
checks(["Quotation", "Tax invoice", "With compliments slip",
        "Printed business cards", "Envelopes", "Proposal / report cover"], cols=3)

section("6", "Timing & investment")
labelled_fields([
    [("Target date / launch", 1), ("Is any part urgent? If so, which?", 1.6), ("Who approves the final designs?", 1.3)],
])
question("So that we present options in the appropriate range, kindly indicate the budget you have in mind:")
checks(["Essentials — R20 000 to R30 000",
        "Standard — R45 000 to R65 000",
        "Comprehensive — R85 000 and above",
        "Prefer to discuss"], cols=2)
note("All figures exclude VAT and are indicative only. The final quotation will be itemised so that you may include or omit any element.")

question("Would you prefer the work to be phased over time rather than delivered all at once?")
checks(["Yes — please propose phases", "No — all at once", "Open to discussion"])

section("7", "Anything else we should know", keep=203)
textfield(M, y[0] - 96, CW, 96, uid("f"), multiline=True, size=8.5)
y[0] -= 106

# ----------------------------------------------------------- closing block ---
need(92)
c.setStrokeColor(RULE)
c.setLineWidth(0.6)
c.line(M, y[0], W - M, y[0])
y[0] -= 14

c.setFont("Helvetica-Bold", 8.6)
c.setFillColor(NAVY)
c.drawString(M, y[0] - 8, "Kindly return the completed form to [your email address].")
y[0] -= 19
c.setFont("Helvetica", 8.4)
c.setFillColor(INK)
c.drawString(M, y[0] - 8, "We will revert with a formal, itemised quotation within two working days of receipt. Should you prefer, we are equally happy to")
y[0] -= 11.5
c.drawString(M, y[0] - 8, "complete this form together over a short telephone call — simply reply with a convenient time.")
y[0] -= 22

need(30)
cw3 = (CW - 20) / 2
c.setFont("Helvetica", 7.6)
c.setFillColor(MUTED)
c.drawString(M + 1, y[0] - 7, "COMPLETED BY")
c.drawString(M + cw3 + 20 + 1, y[0] - 7, "DATE")
textfield(M, y[0] - 26, cw3, 17, uid("f"))
textfield(M + cw3 + 20, y[0] - 26, cw3, 17, uid("f"))

page_footer()
c.save()
print("written:", OUT, "pages:", page_no[0])
