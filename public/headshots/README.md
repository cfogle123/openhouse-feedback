# Agent headshots

Drop a photo in this folder named after the agent's slug (their name,
lowercased, spaces replaced with dashes) and it'll automatically show up
instead of their initial on the "select your name" screens (Feedback,
Availability, Visitor Sign-In).

Supported file types: .jpg, .jpeg, .png, .webp
Square-ish photos work best -- they're cropped into a circle.

Exact filenames for the current agents:

- meredith.jpg
- chris.jpg
- rose.jpg
- stacy.jpg
- sandy.jpg
- dale.jpg
- patrick.jpg
- jason.jpg
- felicia.jpg
- francisco.jpg

No code changes or database work needed -- just upload the photo file(s)
into this exact folder (public/headshots/) via GitHub the same way you
upload everything else, and Render will pick it up on the next deploy.
Agents without a photo file here will keep showing their initial as before.
